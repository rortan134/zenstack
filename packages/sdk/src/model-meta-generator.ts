import {
    ArrayExpr,
    DataModel,
    DataModelField,
    isArrayExpr,
    isBooleanLiteral,
    isDataModel,
    isNumberLiteral,
    isReferenceExpr,
    isStringLiteral,
    ReferenceExpr,
} from '@zenstackhq/language/ast';
import type { RuntimeAttribute } from '@zenstackhq/runtime';
import { lowerCaseFirst } from 'lower-case-first';
import { CodeBlockWriter, Project, VariableDeclarationKind } from 'ts-morph';
import {
    emitProject,
    getAttribute,
    getAttributeArg,
    getAttributeArgs,
    getAuthModel,
    getDataModels,
    getLiteral,
    hasAttribute,
    isEnumFieldReference,
    isForeignKeyField,
    isIdField,
    resolved,
    saveProject,
} from '.';

export type ModelMetaGeneratorOptions = {
    output: string;
    compile: boolean;
    preserveTsFiles: boolean;
    generateAttributes: boolean;
};

export async function generate(project: Project, models: DataModel[], options: ModelMetaGeneratorOptions) {
    const sf = project.createSourceFile(options.output, undefined, { overwrite: true });
    sf.addStatements('/* eslint-disable */');
    sf.addVariableStatement({
        declarationKind: VariableDeclarationKind.Const,
        declarations: [{ name: 'metadata', initializer: (writer) => generateModelMetadata(models, writer, options) }],
    });
    sf.addStatements('export default metadata;');

    if (!options.compile || options.preserveTsFiles) {
        // save ts files
        await saveProject(project);
    }
    if (options.compile) {
        await emitProject(project);
    }
}

function generateModelMetadata(dataModels: DataModel[], writer: CodeBlockWriter, options: ModelMetaGeneratorOptions) {
    writer.block(() => {
        writer.write('fields:');
        writer.block(() => {
            for (const model of dataModels) {
                writer.write(`${lowerCaseFirst(model.name)}:`);
                writer.block(() => {
                    for (const f of model.fields) {
                        const backlink = getBackLink(f);
                        const fkMapping = generateForeignKeyMapping(f);
                        writer.write(`${f.name}: {
                    name: "${f.name}",
                    type: "${
                        f.type.reference
                            ? f.type.reference.$refText
                            : // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                              f.type.type!
                    }",
                    isId: ${isIdField(f)},
                    isDataModel: ${isDataModel(f.type.reference?.ref)},
                    isArray: ${f.type.array},
                    isOptional: ${f.type.optional},
                    attributes: ${options.generateAttributes ? JSON.stringify(getFieldAttributes(f)) : '[]'},
                    backLink: ${backlink ? "'" + backlink.name + "'" : 'undefined'},
                    isRelationOwner: ${isRelationOwner(f, backlink)},
                    isForeignKey: ${isForeignKeyField(f)},
                    foreignKeyMapping: ${fkMapping ? JSON.stringify(fkMapping) : 'undefined'}
                },`);
                    }
                });
                writer.write(',');
            }
        });
        writer.write(',');

        writer.write('uniqueConstraints:');
        writer.block(() => {
            for (const model of dataModels) {
                writer.write(`${lowerCaseFirst(model.name)}:`);
                writer.block(() => {
                    for (const constraint of getUniqueConstraints(model)) {
                        writer.write(`${constraint.name}: {
                    name: "${constraint.name}",
                    fields: ${JSON.stringify(constraint.fields)}
                },`);
                    }
                });
                writer.write(',');
            }
        });
        writer.write(',');

        writer.write('deleteCascade:');
        writer.block(() => {
            for (const model of dataModels) {
                const cascades = getDeleteCascades(model);
                if (cascades.length > 0) {
                    writer.writeLine(`${lowerCaseFirst(model.name)}: [${cascades.map((n) => `'${n}'`).join(', ')}],`);
                }
            }
        });
        writer.write(',');

        const authModel = getAuthModel(dataModels);
        if (authModel) {
            writer.writeLine(`authModel: '${authModel.name}'`);
        }
    });
}

function getBackLink(field: DataModelField) {
    if (!field.type.reference?.ref || !isDataModel(field.type.reference?.ref)) {
        return undefined;
    }

    const relName = getRelationName(field);

    const sourceModel = field.$container as DataModel;
    const targetModel = field.type.reference.ref as DataModel;

    for (const otherField of targetModel.fields) {
        if (otherField.type.reference?.ref === sourceModel) {
            if (relName) {
                const otherRelName = getRelationName(otherField);
                if (relName === otherRelName) {
                    return otherField;
                }
            } else {
                return otherField;
            }
        }
    }
    return undefined;
}

function getRelationName(field: DataModelField) {
    const relAttr = field.attributes.find((attr) => attr.decl.ref?.name === 'relation');
    const relName = relAttr && relAttr.args?.[0] && getLiteral<string>(relAttr.args?.[0].value);
    return relName;
}

function getFieldAttributes(field: DataModelField): RuntimeAttribute[] {
    return field.attributes
        .map((attr) => {
            const args: Array<{ name?: string; value: unknown }> = [];
            for (const arg of attr.args) {
                if (isNumberLiteral(arg.value)) {
                    let v = parseInt(arg.value.value);
                    if (isNaN(v)) {
                        v = parseFloat(arg.value.value);
                    }
                    if (isNaN(v)) {
                        throw new Error(`Invalid number literal: ${arg.value.value}`);
                    }
                    args.push({ name: arg.name, value: v });
                } else if (isStringLiteral(arg.value) || isBooleanLiteral(arg.value)) {
                    args.push({ name: arg.name, value: arg.value.value });
                } else {
                    // attributes with non-literal args are skipped
                    return undefined;
                }
            }
            return { name: resolved(attr.decl).name, args };
        })
        .filter((d): d is RuntimeAttribute => !!d);
}

function getUniqueConstraints(model: DataModel) {
    const constraints: Array<{ name: string; fields: string[] }> = [];

    // model-level constraints
    for (const attr of model.attributes.filter(
        (attr) => attr.decl.ref?.name === '@@unique' || attr.decl.ref?.name === '@@id'
    )) {
        const argsMap = getAttributeArgs(attr);
        if (argsMap.fields) {
            const fieldNames = (argsMap.fields as ArrayExpr).items.map(
                (item) => resolved((item as ReferenceExpr).target).name
            );
            let constraintName = argsMap.name && getLiteral<string>(argsMap.name);
            if (!constraintName) {
                // default constraint name is fields concatenated with underscores
                constraintName = fieldNames.join('_');
            }
            constraints.push({ name: constraintName, fields: fieldNames });
        }
    }

    // field-level constraints
    for (const field of model.fields) {
        if (hasAttribute(field, '@id') || hasAttribute(field, '@unique')) {
            constraints.push({ name: field.name, fields: [field.name] });
        }
    }

    return constraints;
}

function isRelationOwner(field: DataModelField, backLink: DataModelField | undefined) {
    if (!isDataModel(field.type.reference?.ref)) {
        return false;
    }

    if (!backLink) {
        // CHECKME: can this really happen?
        return true;
    }

    if (!hasAttribute(field, '@relation') && !hasAttribute(backLink, '@relation')) {
        // if neither side has `@relation` attribute, it's an implicit many-to-many relation,
        // both sides are owners
        return true;
    }

    return holdsForeignKey(field);
}

function holdsForeignKey(field: DataModelField) {
    const relation = field.attributes.find((attr) => attr.decl.ref?.name === '@relation');
    if (!relation) {
        return false;
    }
    const fields = getAttributeArg(relation, 'fields');
    return !!fields;
}

function generateForeignKeyMapping(field: DataModelField) {
    const relation = field.attributes.find((attr) => attr.decl.ref?.name === '@relation');
    if (!relation) {
        return undefined;
    }
    const fields = getAttributeArg(relation, 'fields');
    const references = getAttributeArg(relation, 'references');
    if (!isArrayExpr(fields) || !isArrayExpr(references) || fields.items.length !== references.items.length) {
        return undefined;
    }

    const fieldNames = fields.items.map((item) => (isReferenceExpr(item) ? item.target.$refText : undefined));
    const referenceNames = references.items.map((item) => (isReferenceExpr(item) ? item.target.$refText : undefined));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result: Record<string, string> = {};
    referenceNames.forEach((name, i) => {
        if (name) {
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            result[name] = fieldNames[i]!;
        }
    });
    return result;
}

function getDeleteCascades(model: DataModel): string[] {
    const allModels = getDataModels(model.$container);
    return allModels
        .filter((m) => {
            if (m === model) {
                return false;
            }
            const relationFields = m.fields.filter((f) => {
                if (f.type.reference?.ref !== model) {
                    return false;
                }
                const relationAttr = getAttribute(f, '@relation');
                if (relationAttr) {
                    const onDelete = getAttributeArg(relationAttr, 'onDelete');
                    if (onDelete && isEnumFieldReference(onDelete) && onDelete.target.ref?.name === 'Cascade') {
                        return true;
                    }
                }
                return false;
            });
            return relationFields.length > 0;
        })
        .map((m) => m.name);
}
