/** 只认自有键，避免用户提供的型号或连接名命中 Object.prototype。 */
export function ownOf<T>(map: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(map, key) ? map[key] : undefined
}
