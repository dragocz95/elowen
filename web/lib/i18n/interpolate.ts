export function interpolate(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (placeholder, key) => key in values ? String(values[key]) : placeholder);
}
