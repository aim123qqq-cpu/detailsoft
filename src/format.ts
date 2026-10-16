/** Russian plural form: pluralRu(2, 'визит', 'визита', 'визитов') → 'визита'. */
export function pluralRu(count: number, one: string, few: string, many: string) {
  const lastTwo = count % 100;
  if (lastTwo >= 11 && lastTwo <= 14) return many;
  if (count % 10 === 1) return one;
  if (count % 10 >= 2 && count % 10 <= 4) return few;
  return many;
}

export const visitsLabel = (count: number) => `${count} ${pluralRu(count, 'визит', 'визита', 'визитов')}`;
