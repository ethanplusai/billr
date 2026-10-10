import { describe, expect, it } from 'vitest'
import { escapeLike, likeAnyFilter, quoteFilterValue } from './shared'

/**
 * The PostgREST filter grammar, not SQL's LIKE grammar.
 *
 * `escapeLike` deals with `%` and `_`, which is everything SQL cares about and
 * nothing PostgREST cares about. `.or()` takes a raw filter EXPRESSION, so a
 * search term carrying a comma and a dot used to become extra filters chosen by
 * whoever called the tool. Proven against a live PostgREST: the unquoted form
 * below came back `42703 column clients.nosuchcol does not exist`, i.e. the
 * injected segment reached the planner as a column reference.
 */
const INJECTION = 'a,nosuchcol.eq.1,name.ilike.'

describe('quoteFilterValue', () => {
  it('wraps a value so PostgREST reads it as one literal', () => {
    expect(quoteFilterValue('plain')).toBe('"plain"')
  })

  it('escapes the two characters that would end the literal early', () => {
    expect(quoteFilterValue('a"b')).toBe('"a\\"b"')
    expect(quoteFilterValue('a\\b')).toBe('"a\\\\b"')
  })

  it('doubles the LIKE escapes escapeLike emits, because PostgREST halves them', () => {
    // Verified against a live PostgREST: inside a quoted value a LONE
    // backslash is dropped (so `\%` would leave % a wildcard) and `\\` is
    // unescaped to one backslash. Doubling here is what makes escapeLike's
    // literal % still reach ILIKE as a literal %.
    expect(quoteFilterValue(escapeLike('50% off_now'))).toBe('"50\\\\% off\\\\_now"')
  })
})

describe('likeAnyFilter', () => {
  it('matches a substring across every named column', () => {
    expect(likeAnyFilter(['name', 'email'], 'acme')).toBe(
      'name.ilike."%acme%",email.ilike."%acme%"',
    )
  })

  it('keeps an injected filter expression inside the literal', () => {
    const filter = likeAnyFilter(['name', 'email'], INJECTION)
    expect(filter).toBe(
      `name.ilike."%${INJECTION}%",email.ilike."%${INJECTION}%"`,
    )
    // Exactly two filters: every comma the caller supplied sits inside a
    // quoted literal, so none of them can start a third.
    const outsideQuotes = filter.split('"').filter((_, i) => i % 2 === 0).join('')
    expect(outsideQuotes.split(',')).toHaveLength(2)
    expect(outsideQuotes).not.toContain('nosuchcol')
  })

  it('still escapes SQL wildcards so a literal % is not a pattern', () => {
    expect(likeAnyFilter(['name'], '50%')).toBe('name.ilike."%50\\\\%%"')
  })

  it('escapes a quote so the term cannot close its own literal', () => {
    expect(likeAnyFilter(['name'], '",id.not.is.null,name.ilike."')).toBe(
      'name.ilike."%\\",id.not.is.null,name.ilike.\\"%"',
    )
  })
})
