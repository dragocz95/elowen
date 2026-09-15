/**
 * Renders a JSON Schema as a TypeScript type literal for the `exec` tool description.
 *
 * Ported 1:1 from Codex `code-mode-protocol/src/json_schema_types.rs` so the declarations the model
 * reads are byte-identical to the ones it was trained against. The budgets exist because a tool
 * schema is attacker-shaped input from an MCP server: a small document with repeated `$ref`s can
 * otherwise expand into an unbounded model-visible string.
 */
import { normalizeCodeModeIdentifier } from './identifiers.js';

/** Expose one nested recursive shape, then fall back to `unknown` on the next occurrence. */
const MAX_LOCAL_REF_EXPANSIONS_PER_PATH = 2;
/** Bound repeated refs and DAG fan-out separately from cycle depth. */
const MAX_TOTAL_LOCAL_REF_EXPANSIONS = 32;
/** Bound individual schema rendering before assembling the final declaration. */
const MAX_RENDERED_SCHEMA_BYTES = 16_000;
/** Charge intermediate render strings as they are built, so repeated local refs cannot allocate
 *  unbounded expanded copies before the final schema cap runs. */
const MAX_RENDER_WORK_BYTES = MAX_RENDERED_SCHEMA_BYTES * 4;

const RENDERABLE_SCHEMA_KEYWORDS = [
  'const',
  'enum',
  'anyOf',
  'oneOf',
  'allOf',
  'type',
  'properties',
  'additionalProperties',
  'required',
  'items',
  'prefixItems',
] as const;

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Byte length, because every budget in the Rust original is measured in bytes, not UTF-16 units. */
function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

export function renderJsonSchemaToTypescript(schema: JsonValue): string {
  const rendered = new JsonSchemaTypeRenderer(schema).render(schema);
  return byteLength(rendered) > MAX_RENDERED_SCHEMA_BYTES ? 'unknown' : rendered;
}

class JsonSchemaTypeRenderer {
  private readonly root: JsonValue;
  /** A nested `$id` starts a new schema resource; fragment-only refs below it are scoped to that
   *  resource, not to the outer document root, so we stop resolving them against the root. */
  private nestedSchemaResourceDepth = 0;
  private readonly activeLocalRefExpansions = new Map<string, number>();
  private remainingLocalRefExpansions = MAX_TOTAL_LOCAL_REF_EXPANSIONS;
  private remainingRenderWorkBytes = MAX_RENDER_WORK_BYTES;
  private renderWorkBudgetExhausted = false;

  constructor(root: JsonValue) {
    this.root = root;
  }

  render(schema: JsonValue): string {
    if (this.renderWorkBudgetExhausted) return 'unknown';

    const entersNestedSchemaResource = schema !== this.root && isJsonObject(schema) && '$id' in schema;
    if (entersNestedSchemaResource) this.nestedSchemaResourceDepth += 1;

    let rendered: string;
    if (schema === true) rendered = 'unknown';
    else if (schema === false) rendered = 'never';
    else if (isJsonObject(schema)) rendered = this.renderMap(schema);
    else rendered = 'unknown';

    if (entersNestedSchemaResource) this.nestedSchemaResourceDepth -= 1;
    return this.finishRender(rendered);
  }

  private renderMap(map: JsonObject): string {
    if (this.renderWorkBudgetExhausted) return 'unknown';

    if ('$ref' in map) return this.renderRef(map);

    if ('const' in map) return this.renderLiteral(map.const as JsonValue);

    const enumValues = map.enum;
    if (Array.isArray(enumValues)) {
      const rendered: string[] = [];
      for (const value of enumValues) {
        const literal = this.renderLiteral(value);
        if (this.renderWorkBudgetExhausted) return 'unknown';
        if (!this.consumeRenderWork(byteLength(literal))) return 'unknown';
        rendered.push(literal);
      }
      if (rendered.length > 0) return rendered.join(' | ');
    }

    for (const key of ['anyOf', 'oneOf'] as const) {
      const variants = map[key];
      if (Array.isArray(variants)) {
        const rendered: string[] = [];
        for (const variant of variants) {
          if (this.renderWorkBudgetExhausted) return 'unknown';
          rendered.push(this.render(variant));
        }
        if (rendered.length > 0) return rendered.join(' | ');
      }
    }

    const allOf = map.allOf;
    if (Array.isArray(allOf)) {
      const rendered: string[] = [];
      for (const variant of allOf) {
        if (this.renderWorkBudgetExhausted) return 'unknown';
        rendered.push(parenthesizeUnionForIntersection(this.render(variant)));
      }
      if (rendered.length > 0) return rendered.join(' & ');
    }

    const schemaType = map.type;
    if (schemaType !== undefined) {
      if (Array.isArray(schemaType)) {
        const rendered: string[] = [];
        for (const entry of schemaType) {
          if (typeof entry !== 'string') continue;
          if (this.renderWorkBudgetExhausted) return 'unknown';
          rendered.push(this.renderTypeKeyword(map, entry));
        }
        if (rendered.length > 0) return rendered.join(' | ');
      }

      if (typeof schemaType === 'string') return this.renderTypeKeyword(map, schemaType);
    }

    if ('properties' in map || 'additionalProperties' in map || 'required' in map) {
      return this.renderObject(map);
    }

    if ('items' in map || 'prefixItems' in map) return this.renderArray(map);

    return 'unknown';
  }

  private renderRef(map: JsonObject): string {
    let referencedType = 'unknown';
    if (this.nestedSchemaResourceDepth === 0) {
      const reference = map.$ref;
      const pointer = typeof reference === 'string' ? localJsonPointer(reference) : undefined;
      if (pointer !== undefined) {
        referencedType = this.expandLocalRef(pointer);
      }
    }
    if (this.renderWorkBudgetExhausted) return 'unknown';

    const siblings: JsonObject = {};
    for (const [key, value] of Object.entries(map)) {
      if (key === '$ref' || key === '$defs' || key === 'definitions') continue;
      siblings[key] = value;
    }
    if (!hasRenderableSchemaKeywords(siblings)) return referencedType;

    const siblingType = this.renderMap(siblings);
    if (referencedType === 'unknown') return siblingType;
    if (siblingType === 'unknown') return referencedType;
    return `(${referencedType}) & (${siblingType})`;
  }

  private expandLocalRef(pointer: string): string {
    const activeExpansions = this.activeLocalRefExpansions.get(pointer) ?? 0;
    if (activeExpansions >= MAX_LOCAL_REF_EXPANSIONS_PER_PATH) return 'unknown';
    if (this.remainingLocalRefExpansions === 0) return 'unknown';

    const target = pointer === '' ? this.root : resolveJsonPointer(this.root, pointer);
    if (target === undefined) return 'unknown';

    this.remainingLocalRefExpansions -= 1;
    this.activeLocalRefExpansions.set(pointer, activeExpansions + 1);
    const rendered = this.render(target);
    if (activeExpansions === 0) this.activeLocalRefExpansions.delete(pointer);
    else this.activeLocalRefExpansions.set(pointer, activeExpansions);
    return rendered;
  }

  private renderTypeKeyword(map: JsonObject, schemaType: string): string {
    switch (schemaType) {
      case 'string':
        return 'string';
      case 'number':
      case 'integer':
        return 'number';
      case 'boolean':
        return 'boolean';
      case 'null':
        return 'null';
      case 'array':
        return this.renderArray(map);
      case 'object':
        return this.renderObject(map);
      default:
        return 'unknown';
    }
  }

  private renderArray(map: JsonObject): string {
    if ('items' in map) {
      const itemType = this.render(map.items as JsonValue);
      if (this.renderWorkBudgetExhausted) return 'unknown';
      return `Array<${itemType}>`;
    }

    const prefixItems = map.prefixItems;
    if (Array.isArray(prefixItems)) {
      const itemTypes: string[] = [];
      for (const item of prefixItems) {
        if (this.renderWorkBudgetExhausted) return 'unknown';
        itemTypes.push(this.render(item));
      }
      if (itemTypes.length > 0) return `[${itemTypes.join(', ')}]`;
    }

    return 'unknown[]';
  }

  private appendAdditionalPropertiesLine(
    lines: string[],
    map: JsonObject,
    properties: JsonObject,
    linePrefix: string,
  ): boolean {
    if ('additionalProperties' in map) {
      const additionalProperties = map.additionalProperties as JsonValue;
      let propertyType: string | undefined;
      if (additionalProperties === true) propertyType = 'unknown';
      else if (additionalProperties === false) propertyType = undefined;
      else propertyType = this.render(additionalProperties);

      if (propertyType !== undefined) {
        return this.pushRenderLine(lines, `${linePrefix}[key: string]: ${propertyType};`);
      }
    } else if (Object.keys(properties).length === 0) {
      return this.pushRenderLine(lines, `${linePrefix}[key: string]: unknown;`);
    }
    return true;
  }

  private renderObjectProperty(name: string, value: JsonValue, required: readonly string[]): string {
    if (byteLength(name) > this.remainingRenderWorkBytes) {
      this.renderWorkBudgetExhausted = true;
      return 'unknown';
    }
    const optional = required.includes(name) ? '' : '?';
    const propertyName = renderJsonSchemaPropertyName(name);
    const propertyType = this.render(value);
    if (this.renderWorkBudgetExhausted) return 'unknown';
    return `${propertyName}${optional}: ${propertyType};`;
  }

  private renderObject(map: JsonObject): string {
    const requiredValue = map.required;
    const required = Array.isArray(requiredValue)
      ? requiredValue.filter((item): item is string => typeof item === 'string')
      : [];
    const properties = isJsonObject(map.properties) ? map.properties : {};

    const sortedProperties = Object.entries(properties).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    );

    if (sortedProperties.some(([, value]) => hasPropertyDescription(value))) {
      const lines: string[] = [];
      if (!this.pushRenderLine(lines, '{')) return 'unknown';
      for (const [name, value] of sortedProperties) {
        const description = isJsonObject(value) && typeof value.description === 'string' ? value.description : undefined;
        if (description !== undefined) {
          for (const raw of description.split('\n')) {
            const descriptionLine = raw.trim();
            if (descriptionLine.length === 0) continue;
            if (
              byteLength(descriptionLine) + 5 > this.remainingRenderWorkBytes
              || !this.pushRenderLine(lines, `  // ${descriptionLine}`)
            ) {
              return 'unknown';
            }
          }
        }

        const property = this.renderObjectProperty(name, value, required);
        if (this.renderWorkBudgetExhausted || !this.pushRenderLine(lines, `  ${property}`)) {
          return 'unknown';
        }
      }

      if (
        !this.appendAdditionalPropertiesLine(lines, map, properties, '  ')
        || !this.pushRenderLine(lines, '}')
      ) {
        return 'unknown';
      }
      return lines.join('\n');
    }

    const lines: string[] = [];
    for (const [name, value] of sortedProperties) {
      const property = this.renderObjectProperty(name, value, required);
      if (this.renderWorkBudgetExhausted || !this.pushRenderLine(lines, property)) return 'unknown';
    }

    if (!this.appendAdditionalPropertiesLine(lines, map, properties, '')) return 'unknown';

    if (lines.length === 0) return '{}';

    return `{ ${lines.join(' ')} }`;
  }

  private finishRender(rendered: string): string {
    return this.consumeRenderWork(byteLength(rendered)) ? rendered : 'unknown';
  }

  private renderLiteral(value: JsonValue): string {
    if (jsonLiteralSerializationUpperBound(value) > this.remainingRenderWorkBytes) {
      this.renderWorkBudgetExhausted = true;
      return 'unknown';
    }
    return renderJsonSchemaLiteral(value);
  }

  private consumeRenderWork(renderedBytes: number): boolean {
    if (renderedBytes > this.remainingRenderWorkBytes) {
      this.renderWorkBudgetExhausted = true;
      return false;
    }
    this.remainingRenderWorkBytes -= renderedBytes;
    return true;
  }

  private pushRenderLine(lines: string[], line: string): boolean {
    if (!this.consumeRenderWork(byteLength(line))) return false;
    lines.push(line);
    return true;
  }
}

function parenthesizeUnionForIntersection(rendered: string): string {
  return rendered.includes(' | ') ? `(${rendered})` : rendered;
}

function localJsonPointer(reference: string): string | undefined {
  if (!reference.startsWith('#')) return undefined;
  const fragment = reference.slice(1);
  let pointer: string;
  try {
    pointer = decodeURIComponent(fragment);
  } catch {
    return undefined;
  }
  if (pointer === '' || pointer.startsWith('/')) return pointer;
  return undefined;
}

/** RFC 6901 resolution, matching `serde_json::Value::pointer`. */
function resolveJsonPointer(root: JsonValue, pointer: string): JsonValue | undefined {
  let current: JsonValue = root;
  for (const rawToken of pointer.split('/').slice(1)) {
    const token = rawToken.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(current)) {
      // serde_json rejects leading zeros and non-numeric tokens for arrays.
      if (!/^(0|[1-9][0-9]*)$/.test(token)) return undefined;
      const index = Number(token);
      if (index >= current.length) return undefined;
      current = current[index] as JsonValue;
      continue;
    }
    if (isJsonObject(current)) {
      if (!(token in current)) return undefined;
      current = current[token] as JsonValue;
      continue;
    }
    return undefined;
  }
  return current;
}

function hasRenderableSchemaKeywords(map: JsonObject): boolean {
  return RENDERABLE_SCHEMA_KEYWORDS.some((key) => key in map);
}

function hasPropertyDescription(value: JsonValue): boolean {
  return isJsonObject(value) && typeof value.description === 'string' && value.description.length > 0;
}

function renderJsonSchemaPropertyName(name: string): string {
  return normalizeCodeModeIdentifier(name) === name ? name : JSON.stringify(name);
}

function renderJsonSchemaLiteral(value: JsonValue): string {
  const serialized = JSON.stringify(value);
  return serialized === undefined ? 'unknown' : serialized;
}

/** Upper bound on the serialized size, so a huge literal is rejected before it is built. */
function jsonLiteralSerializationUpperBound(value: JsonValue): number {
  if (value === null) return 4;
  if (value === false) return 5;
  if (value === true) return 4;
  if (typeof value === 'number') return String(value).length;
  if (typeof value === 'string') return byteLength(value) * 6 + 2;
  if (Array.isArray(value)) {
    return value.reduce<number>((size, entry) => size + 1 + jsonLiteralSerializationUpperBound(entry), 2);
  }
  return Object.entries(value).reduce<number>(
    (size, [key, entry]) => size + 4 + byteLength(key) * 6 + jsonLiteralSerializationUpperBound(entry),
    2,
  );
}
