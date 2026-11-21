import type { Entry } from '@magic/contracts'

export const substantiveEntries = (entries: readonly Entry[]): readonly Entry[] => entries.filter(entry => entry.kind !== 'summary' && entry.kind !== 'continuation')
export class PreparationFailure extends Error {
  constructor(readonly kind: 'capacity' | 'changed' | 'incomplete', message: string) { super(message) }
}
export const preparationReserve = (inputBudget: number) => Math.max(512, Math.ceil(inputBudget * .15))
export type PreparationCapacity = { readonly inputBudget?: number; readonly maxOutputTokens?: number; readonly identity?: string }
