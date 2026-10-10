import { describe, expect, it } from 'vitest'
import { secondsFromHours, timeAmount } from './time'

describe('measured time billing', () => {
  it('keeps a 36-second task at one dollar at every step', () => {
    const seconds = secondsFromHours(0.01)
    expect(seconds).toBe(36)
    expect(timeAmount(seconds, 100)).toBe(1)
    expect(timeAmount(secondsFromHours(seconds / 3600), 100)).toBe(1)
  })
  it('distinguishes unknown pricing from a free rate', () => {
    expect(timeAmount(60, null)).toBeNull()
    expect(timeAmount(60, 0)).toBe(0)
  })
  it('rejects empty or non-finite durations', () => {
    for (const value of [0, -1, Infinity, NaN, 25]) expect(() => secondsFromHours(value)).toThrow()
  })
})
