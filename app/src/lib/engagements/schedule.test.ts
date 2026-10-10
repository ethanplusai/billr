import { describe, it, expect } from 'vitest'
import {
  DEFAULT_SCHEDULE_TEMPLATES,
  ScheduleError,
  expandSchedule,
  expandTemplate,
  type ScheduleEntry,
} from './schedule'

/**
 * SHARED CASES.
 *
 * Every case in SPLIT_CASES is asserted twice: here against the TypeScript
 * expansion the UI previews with, and in supabase/tests/engagements.sql
 * against expand_engagement_schedule(), which is what actually writes the
 * rows. The two lists are kept literally identical, case for case and cent for
 * cent, because the whole point of the preview is that it tells the truth
 * about what the database is going to do.
 */
const SPLIT_CASES: {
  name: string
  mode: 'percent_split' | 'equal_installments'
  total: number
  percents?: number[]
  count?: number
  expected: number[]
}[] = [
  { name: '50/50 of 1000', mode: 'percent_split', total: 1000, percents: [50, 50], expected: [500, 500] },
  {
    name: '30/70 of 999.99 rounds up and lets the last entry absorb it',
    mode: 'percent_split',
    total: 999.99,
    percents: [30, 70],
    expected: [300, 699.99],
  },
  {
    name: 'thirds of 100 as percentages',
    mode: 'percent_split',
    total: 100,
    percents: [33.33, 33.33, 33.34],
    expected: [33.33, 33.33, 33.34],
  },
  { name: '3 equal of 100', mode: 'equal_installments', total: 100, count: 3, expected: [33.33, 33.33, 33.34] },
  {
    name: '3 equal of 1000',
    mode: 'equal_installments',
    total: 1000,
    count: 3,
    expected: [333.33, 333.33, 333.34],
  },
  {
    name: '7 equal of 100',
    mode: 'equal_installments',
    total: 100,
    count: 7,
    expected: [14.29, 14.29, 14.29, 14.29, 14.29, 14.29, 14.26],
  },
  {
    name: '10 equal of 1000.05 rounds each half-cent up',
    mode: 'equal_installments',
    total: 1000.05,
    count: 10,
    expected: [100.01, 100.01, 100.01, 100.01, 100.01, 100.01, 100.01, 100.01, 100.01, 99.96],
  },
  {
    name: '10 equal of 0.1 leaves the remainder on the last entry',
    mode: 'equal_installments',
    total: 0.1,
    count: 10,
    expected: [0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01],
  },
]

function amounts(entries: ScheduleEntry[]): number[] {
  return entries.map((entry) => entry.amount)
}

function sum(values: number[]): number {
  return Math.round(values.reduce((total, value) => total + value, 0) * 100) / 100
}

describe('expandSchedule', () => {
  for (const testCase of SPLIT_CASES) {
    it(`splits ${testCase.name}`, () => {
      const entries = expandSchedule({
        billing_mode: testCase.mode,
        total: testCase.total,
        entries: testCase.percents?.map((percent) => ({ percent })) ?? null,
        installments: testCase.count ?? null,
      })

      expect(amounts(entries)).toEqual(testCase.expected)
      expect(sum(amounts(entries))).toBe(testCase.total)
    })
  }

  it('numbers positions from zero in the order given', () => {
    const entries = expandSchedule({
      billing_mode: 'equal_installments',
      total: 300,
      installments: 3,
    })
    expect(entries.map((entry) => entry.position)).toEqual([0, 1, 2])
  })

  it('keeps the percentages it was given on a percent split', () => {
    const entries = expandSchedule({
      billing_mode: 'percent_split',
      total: 1000,
      entries: [{ percent: 30 }, { percent: 70 }],
    })
    expect(entries.map((entry) => entry.percent)).toEqual([30, 70])
  })

  it('leaves percent empty when the split was not stated as percentages', () => {
    const entries = expandSchedule({ billing_mode: 'equal_installments', total: 300, installments: 3 })
    expect(entries.map((entry) => entry.percent)).toEqual([null, null, null])
  })

  it('defaults the due rules to start, milestones, completion', () => {
    const entries = expandSchedule({ billing_mode: 'equal_installments', total: 400, installments: 4 })
    expect(entries.map((entry) => entry.due_rule)).toEqual([
      'on_start',
      'on_milestone',
      'on_milestone',
      'on_complete',
    ])
  })

  it('defaults a single entry to completion', () => {
    const entries = expandSchedule({ billing_mode: 'milestones', total: 400, entries: [{ amount: 400 }] })
    expect(entries[0].due_rule).toBe('on_complete')
  })

  it('leaves every entry of a manual engagement waiting for a person', () => {
    const entries = expandSchedule({
      billing_mode: 'manual',
      total: 400,
      entries: [{ amount: 100 }, { amount: 300 }],
    })
    expect(entries.map((entry) => entry.due_rule)).toEqual(['manual', 'manual'])
  })

  it('keeps an explicit due rule and its date', () => {
    const entries = expandSchedule({
      billing_mode: 'milestones',
      total: 400,
      entries: [
        { amount: 100, due_rule: 'on_date', due_on: '2026-10-01' },
        { amount: 300, due_rule: 'manual' },
      ],
    })
    expect(entries[0].due_rule).toBe('on_date')
    expect(entries[0].due_on).toBe('2026-10-01')
    expect(entries[1].due_on).toBeNull()
  })

  it('drops a date on an entry that is not due on a date', () => {
    const entries = expandSchedule({
      billing_mode: 'milestones',
      total: 100,
      entries: [{ amount: 100, due_rule: 'on_complete', due_on: '2026-10-01' }],
    })
    expect(entries[0].due_on).toBeNull()
  })

  it('names unlabelled entries', () => {
    const entries = expandSchedule({ billing_mode: 'equal_installments', total: 200, installments: 2 })
    expect(entries.map((entry) => entry.label)).toEqual(['Installment 1 of 2', 'Installment 2 of 2'])
  })

  it('keeps the labels it was given', () => {
    const entries = expandSchedule({
      billing_mode: 'percent_split',
      total: 200,
      entries: [
        { label: 'Deposit', percent: 50 },
        { label: 'On completion', percent: 50 },
      ],
    })
    expect(entries.map((entry) => entry.label)).toEqual(['Deposit', 'On completion'])
  })
})

describe('expandSchedule refusals', () => {
  const cases: { name: string; code: string; input: Parameters<typeof expandSchedule>[0] }[] = [
    {
      name: 'percentages that do not add up to 100',
      code: 'percent_must_total_100',
      input: { billing_mode: 'percent_split', total: 1000, entries: [{ percent: 30 }, { percent: 60 }] },
    },
    {
      name: 'a percent split with an entry carrying no percent',
      code: 'invalid_percent',
      input: { billing_mode: 'percent_split', total: 1000, entries: [{ percent: 100 }, {}] },
    },
    {
      name: 'milestone amounts that do not add up to the total',
      code: 'entries_must_total_engagement',
      input: { billing_mode: 'milestones', total: 10000, entries: [{ amount: 2500 }, { amount: 2500 }] },
    },
    {
      name: 'a milestone with no amount',
      code: 'entry_amount_required',
      input: { billing_mode: 'milestones', total: 100, entries: [{ label: 'Kickoff' }] },
    },
    {
      name: 'a zero total',
      code: 'invalid_total',
      input: { billing_mode: 'equal_installments', total: 0, installments: 2 },
    },
    {
      name: 'a negative total',
      code: 'invalid_total',
      input: { billing_mode: 'equal_installments', total: -100, installments: 2 },
    },
    {
      name: 'no installment count at all',
      code: 'invalid_installments',
      input: { billing_mode: 'equal_installments', total: 100 },
    },
    {
      name: 'more installments than the schedule cap',
      code: 'invalid_installments',
      input: { billing_mode: 'equal_installments', total: 100, installments: 101 },
    },
    {
      name: 'a schedule with no entries',
      code: 'entries_required',
      input: { billing_mode: 'milestones', total: 100, entries: [] },
    },
    {
      name: 'an entry due on a date with no date',
      code: 'due_on_required',
      input: {
        billing_mode: 'milestones',
        total: 100,
        entries: [{ amount: 100, due_rule: 'on_date' }],
      },
    },
    {
      name: 'an installment split too small to give every entry a cent',
      code: 'invalid_entry_amount',
      input: { billing_mode: 'equal_installments', total: 0.01, installments: 3 },
    },
  ]

  for (const testCase of cases) {
    it(`refuses ${testCase.name}`, () => {
      try {
        expandSchedule(testCase.input)
        throw new Error('expected expandSchedule to refuse this schedule')
      } catch (error) {
        expect(error).toBeInstanceOf(ScheduleError)
        expect((error as ScheduleError).code).toBe(testCase.code)
      }
    })
  }
})

describe('schedule templates', () => {
  it('expands every seeded template into a schedule that sums to the total', () => {
    for (const template of DEFAULT_SCHEDULE_TEMPLATES) {
      const entries = expandTemplate(template, 12345.67)
      expect(sum(amounts(entries))).toBe(12345.67)
      expect(entries.length).toBeGreaterThan(0)
    }
  })

  it('expands 50/50 and 30/70 the way their names promise', () => {
    const half = expandTemplate(DEFAULT_SCHEDULE_TEMPLATES[0], 8000)
    expect(amounts(half)).toEqual([4000, 4000])
    expect(half.map((entry) => entry.due_rule)).toEqual(['on_start', 'on_complete'])

    const deposit = expandTemplate(DEFAULT_SCHEDULE_TEMPLATES[1], 8000)
    expect(amounts(deposit)).toEqual([2400, 5600])
  })

  it('expands the three phase template into three equal named entries', () => {
    const phases = expandTemplate(DEFAULT_SCHEDULE_TEMPLATES[2], 100)
    expect(amounts(phases)).toEqual([33.33, 33.33, 33.34])
    expect(phases.map((entry) => entry.label)).toEqual(['Design', 'Build', 'Launch'])
  })

  it('expands ten installments', () => {
    expect(expandTemplate(DEFAULT_SCHEDULE_TEMPLATES[3], 1000)).toHaveLength(10)
  })
})
