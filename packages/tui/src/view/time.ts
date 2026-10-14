/** 时刻 → `MM-DD`（本地时区）——抽屉里只报「最近什么时候」，精确到分没必要。 */
export function dayLabel(at: number): string {
  const d = new Date(at)

  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 一段时长 → 人读（`12 秒` / `3 分 12 秒` / `2 小时 5 分`）——**不报小数秒**。 */
export function elapsedLabel(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`
}

/** 时刻（`12:03:41`）——一天之内的事不必带日期。 */
export function clockLabel(at: number): string {
  const date = new Date(at)

  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}
