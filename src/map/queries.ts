import type { LangId } from './languages.ts'

/**
 * JavaScript and TypeScript `#private` members (`#fetch() {}`, `this.#fetch()`): the shipped tags only see
 * ordinary names, so without these a private method's calls were credited to its whole class.
 */
const PRIVATE_MEMBERS = [
  '(method_definition name: (private_property_identifier) @name) @definition.method',
  '(call_expression function: (member_expression property: (private_property_identifier) @name)) @reference.call',
]

/**
 * Tag patterns the grammar package does not ship, or ships only in part. They follow the standard
 * tags convention: `@name` plus `@definition.<kind>` or `@reference.<kind>`.
 */
export const EXTRA_TAGS: Partial<Record<LangId, string[]>> = {
  typescript: [
    ...PRIVATE_MEMBERS,
    '(class_declaration name: (type_identifier) @name) @definition.class',
    '(type_alias_declaration name: (type_identifier) @name) @definition.type',
    '(enum_declaration name: (identifier) @name) @definition.enum',
    '(public_field_definition name: (property_identifier) @name value: [(arrow_function) (function_expression)]) @definition.method',
  ],
  tsx: [
    ...PRIVATE_MEMBERS,
    '(class_declaration name: (type_identifier) @name) @definition.class',
    '(type_alias_declaration name: (type_identifier) @name) @definition.type',
    '(enum_declaration name: (identifier) @name) @definition.enum',
    '(public_field_definition name: (property_identifier) @name value: [(arrow_function) (function_expression)]) @definition.method',
  ],
  javascript: [
    ...PRIVATE_MEMBERS,
    '(field_definition property: (property_identifier) @name value: [(arrow_function) (function_expression)]) @definition.method',
  ],
  kotlin: [
    '(class_declaration (type_identifier) @name) @definition.class',
    '(object_declaration (type_identifier) @name) @definition.class',
    '(function_declaration (simple_identifier) @name) @definition.function',
    '(call_expression (simple_identifier) @name) @reference.call',
    '(call_expression (navigation_expression (navigation_suffix (simple_identifier) @name))) @reference.call',
  ],
  csharp: [
    // the shipped tags only see calls on an object (`repo.Save()`); plain calls (`Helper()`) are added here
    '(invocation_expression function: (identifier) @name) @reference.call',
    '(struct_declaration name: (identifier) @name) @definition.class',
    '(record_declaration name: (identifier) @name) @definition.class',
    '(enum_declaration name: (identifier) @name) @definition.enum',
  ],
  powershell: [
    '(function_statement (function_name) @name) @definition.function',
    '(command (command_name) @name) @reference.call',
  ],
}

/** Directive predicates (`#strip!`, `#select-adjacent!`) only shape documentation captures; the map does not need them. */
export const stripDirectives = (scm: string): string => scm.replace(/\(#[a-z-]+!(?:\s+(?:"(?:[^"\\]|\\.)*"|@?[\w.-]+))*\s*\)/g, '')
