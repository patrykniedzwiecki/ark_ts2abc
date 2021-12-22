/*
 * Copyright (c) 2021 Huawei Device Co., Ltd.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import * as ts from "typescript";
import {
    Literal,
    LiteralBuffer,
    LiteralTag
} from "./literal";
import { LOGD } from "../log";
import { TypeChecker } from "../typeChecker";
import { TypeRecorder } from "../typeRecorder";
import { PandaGen } from "../pandagen";
import * as jshelpers from "../jshelpers";
import { access } from "fs";

export enum PrimitiveType {
    ANY,
    NUMBER,
    BOOLEAN,
    STRING,
    SYMBOL,
    NULL,
    UNDEFINED,
    _LENGTH = 50
}

export enum L2Type {
    CLASS,
    CLASSINST,
    FUNCTION,
    OBJECT, // object literal
    EXTERNAL,
    _COUNTER
}

export enum ModifierAbstract {
    NONABSTRACT,
    ABSTRACT
}

export enum ModifierStatic {
    NONSTATIC,
    STATIC
}

export enum ModifierReadonly {
    NONREADONLY,
    READONLY
}

export enum AccessFlag {
    PUBLIC,
    PRIVATE,
    PROTECTED
}

type ClassMemberFunction = ts.MethodDeclaration | ts.ConstructorDeclaration | ts.GetAccessorDeclaration | ts.SetAccessorDeclaration;

export abstract class BaseType {

    abstract transfer2LiteralBuffer(): LiteralBuffer;
    protected typeChecker = TypeChecker.getInstance();
    protected typeRecorder = TypeRecorder.getInstance();

    protected addCurrentType(node: ts.Node, index: number) {
        this.typeRecorder.addType2Index(node, index);
    }

    protected setVariable2Type(variableNode: ts.Node, index: number, isUserDefinedType: boolean) {
        this.typeRecorder.setVariable2Type(variableNode, index, isUserDefinedType);
    }

    protected tryGetTypeIndex(typeNode: ts.Node) {
        return this.typeRecorder.tryGetTypeIndex(typeNode);
    }

    protected createType(node: ts.Node, newExpressionFlag: boolean, variableNode?: ts.Node) {
        switch (node.kind) {
            case ts.SyntaxKind.MethodDeclaration:
            case ts.SyntaxKind.Constructor:
            case ts.SyntaxKind.GetAccessor:
            case ts.SyntaxKind.SetAccessor: {
                new FunctionType(<ts.FunctionLikeDeclaration>node, variableNode);
                break;
            }
            case ts.SyntaxKind.ClassDeclaration: {
                new ClassType(<ts.ClassDeclaration>node, newExpressionFlag, variableNode);
                break;
            }
            // create other type as project goes on;
            default:
                LOGD("Error: Currently this type is not supported");
                // throw new Error("Currently this type is not supported");
        }
    }

    protected getOrCreateUserDefinedType(node: ts.Identifier, newExpressionFlag: boolean, variableNode?: ts.Node) {
        let typeIndex = -1;
        let declNode = this.typeChecker.getTypeDeclForIdentifier(node);
        if (declNode) {
            typeIndex = this.tryGetTypeIndex(declNode);
            if (typeIndex == -1) {
                this.createType(declNode, newExpressionFlag, variableNode);
                typeIndex = this.tryGetTypeIndex(declNode);
            }
        }
        return typeIndex;
    }

    protected getTypeIndexForDeclWithType(
        node: ts.FunctionLikeDeclaration | ts.ParameterDeclaration | ts.PropertyDeclaration, variableNode?: ts.Node): number {
        if (node.type) {
            // check for newExpression 
            let newExpressionFlag = false;
            if (node.kind == ts.SyntaxKind.PropertyDeclaration && node.initializer && node.initializer.kind == ts.SyntaxKind.NewExpression) {
                newExpressionFlag = true;
            }
            // get typeFlag to check if its a primitive type
            let typeRef = node.type;
            let typeIndex = this.typeChecker.checkPotentialPrimitiveType(typeRef);
            let isUserDefinedType = false;
            if (!typeIndex) {
                let identifier = <ts.Identifier>typeRef.getChildAt(0);
                typeIndex = this.getOrCreateUserDefinedType(identifier, newExpressionFlag, variableNode);
                isUserDefinedType = true;
            }
            // set variable if variable node is given;
            if (variableNode) {
                this.setVariable2Type(variableNode, typeIndex, isUserDefinedType);
            }
            if (!typeIndex) {
                LOGD("ERROR: Type cannot be found for: " + jshelpers.getTextOfNode(node));
                typeIndex = -1;
            }
            return typeIndex!;
        }
        LOGD("WARNING: node type not found for: " + jshelpers.getTextOfNode(node));
        return -1;
    }

    protected getIndexFromTypeArrayBuffer(type: BaseType): number {
        return PandaGen.appendTypeArrayBuffer(type);
    }

    protected setTypeArrayBuffer(type: BaseType, index: number) {
        PandaGen.setTypeArrayBuffer(type, index);
    }

}

export class PlaceHolderType extends BaseType {
    transfer2LiteralBuffer(): LiteralBuffer {
        return new LiteralBuffer();
    }
}

export class TypeSummary extends BaseType {
    preservedIndex: number = 0;
    userDefinedClassNum: number = 0;
    anonymousRedirect: Array<string> = new Array<string>();
    constructor() {
        super();
        this.preservedIndex = this.getIndexFromTypeArrayBuffer(new PlaceHolderType());
    }

    public setInfo(userDefinedClassNum: number, anonymousRedirect: Array<string>) {
        this.userDefinedClassNum = userDefinedClassNum;
        this.anonymousRedirect = anonymousRedirect;
        this.setTypeArrayBuffer(this, this.preservedIndex);
    }

    transfer2LiteralBuffer(): LiteralBuffer {
        let countBuf = new LiteralBuffer();
        let summaryLiterals: Array<Literal> = new Array<Literal>();
        summaryLiterals.push(new Literal(LiteralTag.INTEGER, L2Type._COUNTER));
        summaryLiterals.push(new Literal(LiteralTag.INTEGER, this.userDefinedClassNum));
        summaryLiterals.push(new Literal(LiteralTag.INTEGER, this.anonymousRedirect.length));
        for (let element of this.anonymousRedirect) {
            summaryLiterals.push(new Literal(LiteralTag.STRING, element));
        }
        countBuf.addLiterals(...summaryLiterals);
        return countBuf;
    }
}

export class ClassType extends BaseType {
    modifier: number = 0; // 0 -> unabstract, 1 -> abstract;
    heritages: Array<number> = new Array<number>();
    // fileds Array: [typeIndex] [public -> 0, private -> 1, protected -> 2] [readonly -> 1]
    staticFields: Map<string, Array<number>> = new Map<string, Array<number>>();
    staticMethods: Array<number> = new Array<number>();
    fields: Map<string, Array<number>> = new Map<string, Array<number>>();
    methods: Array<number> = new Array<number>();
    typeIndex: number;

    constructor(classNode: ts.ClassDeclaration | ts.ClassExpression, newExpressionFlag: boolean, variableNode?: ts.Node) {
        super();
        this.typeIndex = this.getIndexFromTypeArrayBuffer(new PlaceHolderType());
        let shiftedIndex = this.typeIndex + PrimitiveType._LENGTH;
        // record type before its initialization, so its index can be recorded
        // in case there's recursive reference of this type
        this.addCurrentType(classNode, shiftedIndex);

        this.fillInModifiers(classNode);
        this.fillInHeritages(classNode);
        this.fillInFieldsAndMethods(classNode);

        // initialization finished, add variable to type if variable is given
        if (variableNode) {
            // if the variable is a instance, create another classInstType instead of current classType itself
            if (newExpressionFlag) {
                new ClassInstType(variableNode, this.typeIndex);
            } else {
                this.setVariable2Type(variableNode, shiftedIndex, true);
            }
        }
        this.setTypeArrayBuffer(this, this.typeIndex);
        // check typeRecorder
        // this.typeRecorder.getLog(classNode, this.typeIndex);
    }

    public getTypeIndex() {
        return this.typeIndex;
    }

    private fillInModifiers(node: ts.ClassDeclaration | ts.ClassExpression) {
        if (node.modifiers) {
            for (let modifier of node.modifiers) {
                switch (modifier.kind) {
                    case ts.SyntaxKind.AbstractKeyword: {
                        this.modifier = ModifierAbstract.ABSTRACT;
                        break;
                    }
                    case ts.SyntaxKind.ExportKeyword: {
                        break;
                    }
                }
            }
        }
    }

    private fillInHeritages(node: ts.ClassDeclaration | ts.ClassExpression) {
        if (node.heritageClauses) {
            for (let heritage of node.heritageClauses) {
                for (let heritageType of heritage.types) {
                    let heritageIdentifier = <ts.Identifier>heritageType.expression;
                    let heritageTypeIndex = this.getOrCreateUserDefinedType(heritageIdentifier, false);
                    this.heritages.push(heritageTypeIndex);
                }
            }
        }
    }

    private fillInFields(member: ts.PropertyDeclaration) {
        // collect modifier info
        let fieldName: string = "";
        switch (member.name.kind) {
            case ts.SyntaxKind.Identifier:
            case ts.SyntaxKind.StringLiteral:
            case ts.SyntaxKind.NumericLiteral:
                fieldName = jshelpers.getTextOfIdentifierOrLiteral(member.name);
                break;
            case ts.SyntaxKind.ComputedPropertyName:
                fieldName = "#computed";
                break;
            default:
                throw new Error("Invalid proerty name");
        }

        // Array: [typeIndex] [public -> 0, private -> 1, protected -> 2] [readonly -> 1]
        let fieldInfo = Array<number>(PrimitiveType.ANY, AccessFlag.PUBLIC, ModifierReadonly.NONREADONLY);
        let isStatic: boolean = false;
        if (member.modifiers) {
            for (let modifier of member.modifiers) {
                switch (modifier.kind) {
                    case ts.SyntaxKind.StaticKeyword: {
                        isStatic = true;
                        break;
                    }
                    case ts.SyntaxKind.PrivateKeyword: {
                        fieldInfo[1] = AccessFlag.PRIVATE;
                        break;
                    }
                    case ts.SyntaxKind.ProtectedKeyword: {
                        fieldInfo[1] = AccessFlag.PROTECTED;
                        break;
                    }
                    case ts.SyntaxKind.ReadonlyKeyword: {
                        fieldInfo[2] = ModifierReadonly.READONLY;
                        break;
                    }
                }
            }
        }
        // collect type info
        let variableNode = member.name ? member.name : undefined;
        fieldInfo[0] = this.getTypeIndexForDeclWithType(member, variableNode);

        if (isStatic) {
            this.staticFields.set(fieldName, fieldInfo);
        } else {
            this.fields.set(fieldName, fieldInfo);
        }
    }

    private fillInMethods(member: ClassMemberFunction) {
        /**
         * a method like declaration in a new class must be a new type,
         * create this type and add it into typeRecorder
         */
        let variableNode = member.name ? member.name : undefined;
        let funcType = new FunctionType(<ts.FunctionLikeDeclaration>member, variableNode);

        // Then, get the typeIndex and fill in the methods array
        let typeIndex = this.tryGetTypeIndex(member);
        let funcModifier = funcType.getModifier();
        if (funcModifier) {
            this.staticMethods.push(typeIndex!);
        } else {
            this.methods.push(typeIndex!);
        }
    }

    private fillInFieldsAndMethods(node: ts.ClassDeclaration | ts.ClassExpression) {
        if (node.members) {
            for (let member of node.members) {
                switch (member.kind) {
                    case ts.SyntaxKind.MethodDeclaration:
                    case ts.SyntaxKind.Constructor:
                    case ts.SyntaxKind.GetAccessor:
                    case ts.SyntaxKind.SetAccessor: {
                        this.fillInMethods(<ClassMemberFunction>member);
                        break;
                    }
                    case ts.SyntaxKind.PropertyDeclaration: {
                        this.fillInFields(<ts.PropertyDeclaration>member);
                        break;
                    }
                }
            }
        }
    }

    transfer2LiteralBuffer() {
        let classTypeBuf = new LiteralBuffer();
        let classTypeLiterals: Array<Literal> = new Array<Literal>();
        // the first element is to determine the L2 type
        classTypeLiterals.push(new Literal(LiteralTag.INTEGER, L2Type.CLASS));
        classTypeLiterals.push(new Literal(LiteralTag.INTEGER, this.modifier));

        classTypeLiterals.push(new Literal(LiteralTag.INTEGER, this.heritages.length));
        this.heritages.forEach(heritage => {
            classTypeLiterals.push(new Literal(LiteralTag.INTEGER, heritage));
        });

        // record static methods and fields;
        this.transferFields2Literal(classTypeLiterals, true);
        this.transferMethods2Literal(classTypeLiterals, true);

        // record unstatic fields and methods
        this.transferFields2Literal(classTypeLiterals, false);
        this.transferMethods2Literal(classTypeLiterals, false);

        classTypeBuf.addLiterals(...classTypeLiterals);
        return classTypeBuf;
    }

    private transferFields2Literal(classTypeLiterals: Array<Literal>, isStatic: boolean) {
        let transferredTarget: Map<string, Array<number>> = isStatic ? this.staticFields : this.fields;

        classTypeLiterals.push(new Literal(LiteralTag.INTEGER, transferredTarget.size));
        transferredTarget.forEach((typeInfo, name) => {
            classTypeLiterals.push(new Literal(LiteralTag.STRING, name));
            classTypeLiterals.push(new Literal(LiteralTag.INTEGER, typeInfo[0])); // typeIndex
            classTypeLiterals.push(new Literal(LiteralTag.INTEGER, typeInfo[1])); // accessFlag
            classTypeLiterals.push(new Literal(LiteralTag.INTEGER, typeInfo[2])); // readonly
        });
    }

    private transferMethods2Literal(classTypeLiterals: Array<Literal>, isStatic: boolean) {
        let transferredTarget: Array<number> = isStatic ? this.staticMethods : this.methods;

        classTypeLiterals.push(new Literal(LiteralTag.INTEGER, transferredTarget.length));
        transferredTarget.forEach(method => {
            classTypeLiterals.push(new Literal(LiteralTag.INTEGER, method));
        });
    }
}

export class ClassInstType extends BaseType {
    shiftedReferredClassIndex: number = 0; // the referred class in the type system;
    constructor(variableNode: ts.Node, referredClassIndex: number) {
        super();
        // use referedClassIndex to point to the actually class type of this instance
        this.shiftedReferredClassIndex = referredClassIndex + PrimitiveType._LENGTH;

        // map variable to classInstType, which has a newly generated index
        let currIndex = this.getIndexFromTypeArrayBuffer(this);
        let shiftedIndex = currIndex + PrimitiveType._LENGTH;
        this.setVariable2Type(variableNode, shiftedIndex, true);
    }

    transfer2LiteralBuffer(): LiteralBuffer {
        let classInstBuf = new LiteralBuffer();
        let classInstLiterals: Array<Literal> = new Array<Literal>();

        classInstLiterals.push(new Literal(LiteralTag.INTEGER, L2Type.CLASSINST));
        classInstLiterals.push(new Literal(LiteralTag.INTEGER, this.shiftedReferredClassIndex));
        classInstBuf.addLiterals(...classInstLiterals);

        return classInstBuf;
    }
}

export class FunctionType extends BaseType {
    name: string | undefined = '';
    accessFlag: number = 0; // 0 -> public -> 0, private -> 1, protected -> 2
    modifierStatic: number = 0; // 0 -> unstatic, 1 -> static
    parameters: Array<number> = new Array<number>();
    returnType: number = 0;
    typeIndex: number;

    constructor(funcNode: ts.FunctionLikeDeclaration, variableNode?: ts.Node) {
        super();
        this.typeIndex = this.getIndexFromTypeArrayBuffer(new PlaceHolderType());
        let shiftedIndex = this.typeIndex + PrimitiveType._LENGTH;
        // record type before its initialization, so its index can be recorded
        // in case there's recursive reference of this type
        this.addCurrentType(funcNode, shiftedIndex);

        if (funcNode.name) {
            this.name = jshelpers.getTextOfIdentifierOrLiteral(funcNode.name);
        } else {
            this.name = "constructor";
        }
        this.fillInModifiers(funcNode);
        this.fillInParameters(funcNode);
        this.fillInReturn(funcNode);

        // initialization finished, add variable to type if variable is given
        if (variableNode) {
            this.setVariable2Type(variableNode, shiftedIndex, true);
        }
        this.setTypeArrayBuffer(this, this.typeIndex);

        // check typeRecorder
        // this.typeRecorder.getLog(funcNode, this.typeIndex);
    }

    public getTypeIndex() {
        return this.typeIndex;
    }

    private fillInModifiers(node: ts.FunctionLikeDeclaration) {
        if (node.modifiers) {
            for (let modifier of node.modifiers) {
                switch (modifier.kind) {
                    case ts.SyntaxKind.PrivateKeyword: {
                        this.accessFlag = AccessFlag.PRIVATE;
                        break;
                    }
                    case ts.SyntaxKind.ProtectedKeyword: {
                        this.accessFlag = AccessFlag.PROTECTED;
                        break;
                    }
                    case ts.SyntaxKind.StaticKeyword: {
                        this.modifierStatic = ModifierStatic.STATIC;
                    }
                }
            }
        }
    }

    private fillInParameters(node: ts.FunctionLikeDeclaration) {
        if (node.parameters) {
            for (let parameter of node.parameters) {
                let variableNode = parameter.name;
                let typeIndex = this.getTypeIndexForDeclWithType(parameter, variableNode);
                this.parameters.push(typeIndex);
            }
        }
    }

    private fillInReturn(node: ts.FunctionLikeDeclaration) {
        let typeIndex = this.getTypeIndexForDeclWithType(node);
        if (typeIndex != -1) {
            this.returnType = typeIndex;
        }
    }

    getModifier() {
        return this.modifierStatic;
    }

    transfer2LiteralBuffer(): LiteralBuffer {
        let funcTypeBuf = new LiteralBuffer();
        let funcTypeLiterals: Array<Literal> = new Array<Literal>();
        funcTypeLiterals.push(new Literal(LiteralTag.INTEGER, L2Type.FUNCTION));
        funcTypeLiterals.push(new Literal(LiteralTag.INTEGER, this.accessFlag));
        funcTypeLiterals.push(new Literal(LiteralTag.INTEGER, this.modifierStatic));
        funcTypeLiterals.push(new Literal(LiteralTag.STRING, this.name));
        funcTypeLiterals.push(new Literal(LiteralTag.INTEGER, this.parameters.length));
        this.parameters.forEach((type) => {
            funcTypeLiterals.push(new Literal(LiteralTag.INTEGER, type));
        });

        funcTypeLiterals.push(new Literal(LiteralTag.INTEGER, this.returnType));
        funcTypeBuf.addLiterals(...funcTypeLiterals);
        return funcTypeBuf;
    }
}

export class ExternalType extends BaseType {
    fullRedirectNath: string;
    typeIndex: number;

    constructor(importName: string, redirectPath: string) {
        super();
        this.fullRedirectNath = `#${importName}#${redirectPath}`;
        this.typeIndex = this.getIndexFromTypeArrayBuffer(this);
    }

    public getTypeIndex() {
        return this.typeIndex;
    }

    transfer2LiteralBuffer(): LiteralBuffer {
        let ImpTypeBuf = new LiteralBuffer();
        let ImpTypeLiterals: Array<Literal> = new Array<Literal>();
        ImpTypeLiterals.push(new Literal(LiteralTag.INTEGER, L2Type.EXTERNAL));
        ImpTypeLiterals.push(new Literal(LiteralTag.STRING, this.fullRedirectNath));
        ImpTypeBuf.addLiterals(...ImpTypeLiterals);
        return ImpTypeBuf;
    }
}

export class ObjectLiteralType extends BaseType {
    private properties: Map<string, number> = new Map<string, number>();
    private methods: Array<number> = new Array<number>();

    constructor(obj: ts.ObjectLiteralExpression) {
        super();

        // TODO extract object info here
    }

    transfer2LiteralBuffer(): LiteralBuffer {
        let objTypeBuf = new LiteralBuffer();

        return objTypeBuf;
    }
}