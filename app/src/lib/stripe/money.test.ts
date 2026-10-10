import { describe, it, expect } from 'vitest'
import { amountToMinorUnits, minorUnitsToAmount } from './money'
import { buildPaymentIntentParams } from './payment-intent'

describe('amountToMinorUnits', () => {
  it('converts major-unit decimals to cents', () => {
    expect(amountToMinorUnits(125.5)).toBe(12550)
    expect(amountToMinorUnits(1)).toBe(100)
    expect(amountToMinorUnits(0.01)).toBe(1)
  })

  it('accepts the string form Postgres returns for DECIMAL columns', () => {
    expect(amountToMinorUnits('125.50')).toBe(12550)
    expect(amountToMinorUnits('0.99')).toBe(99)
  })

  it('rounds float representation noise rather than truncating a cent away', () => {
    // 8.29 * 100 is 828.9999999999999 in IEEE 754; truncating would bill 8.28.
    expect(amountToMinorUnits(8.29)).toBe(829)
    expect(amountToMinorUnits(19.99)).toBe(1999)
    expect(amountToMinorUnits(0.29)).toBe(29)
    expect(amountToMinorUnits(1.1)).toBe(110)
  })

  it('rounds half-cent inputs down when the float lands below the midpoint', () => {
    // Documenting real behaviour rather than an aspiration: balance_due is a
    // DECIMAL(12,2), so a half-cent value cannot occur in practice, and both
    // checkout surfaces share this helper so they cannot disagree either way.
    expect(amountToMinorUnits(1.005)).toBe(100)
  })
})

describe('the card form charges the invoice amount', () => {
  // The PaymentIntent amount must always match amountToMinorUnits for the
  // invoice balance. This locks that in for the awkward values.
  const cases = ['0.01', '19.99', '125.50', '1.005', 1000, 0.29]

  it.each(cases)('agrees on %s', (balanceDue) => {
    const intent = buildPaymentIntentParams({
      currency: 'usd',
      invoiceNumber: 'INV-1',
      balanceDue,
      invoiceId: 'inv_1',
      businessId: 'biz_1',
      publicId: 'pub_1',
    })
    expect(intent.amount).toBe(amountToMinorUnits(balanceDue))
  })
})

describe('currency-specific charge units',()=>{
 it('charges yen as yen, not cents',()=>{expect(amountToMinorUnits(1200,'JPY')).toBe(1200);expect(amountToMinorUnits(1200,'USD')).toBe(120000)})
 it('rejects fractional yen instead of silently changing the invoice',()=>expect(()=>amountToMinorUnits(1.5,'JPY')).toThrow())
 it('preserves the special Stripe representation for ISK and UGX',()=>{expect(amountToMinorUnits(5,'ISK')).toBe(500);expect(()=>amountToMinorUnits(5.5,'UGX')).toThrow()})
 it('rejects invalid or unsafe amounts',()=>{for(const amount of [NaN,Infinity,-1,Number.MAX_SAFE_INTEGER])expect(()=>amountToMinorUnits(amount)).toThrow()})
})

describe('three-decimal currencies', () => {
  // Stripe charges BHD, JOD, KWD, OMR and TND in thousandths, and the amount
  // must end in 0. Multiplying by 100 would charge a tenth of the invoice.
  it('charges three-decimal currencies in thousandths', () => {
    expect(amountToMinorUnits(10, 'kwd')).toBe(10000)
    for (const code of ['BHD', 'JOD', 'KWD', 'OMR', 'TND']) {
      expect(amountToMinorUnits(1.25, code)).toBe(1250)
    }
  })

  it('rounds to the nearest 10 minor units so the amount ends in 0', () => {
    const minor = amountToMinorUnits(10.005, 'kwd')
    expect(minor % 10).toBe(0)
    expect([10000, 10010]).toContain(minor)
    expect(amountToMinorUnits(10.006, 'KWD')).toBe(10010)
    expect(amountToMinorUnits(10.004, 'KWD')).toBe(10000)
  })

  it('converts thousandths back to the invoice amount', () => {
    expect(minorUnitsToAmount(10000, 'kwd')).toBe(10)
    expect(minorUnitsToAmount(1250, 'OMR')).toBe(1.25)
  })

  it('leaves two-decimal and zero-decimal currencies unchanged', () => {
    expect(amountToMinorUnits(10, 'USD')).toBe(1000)
    expect(amountToMinorUnits(10.5, 'EUR')).toBe(1050)
    expect(amountToMinorUnits(10, 'JPY')).toBe(10)
    expect(minorUnitsToAmount(1000, 'USD')).toBe(10)
    expect(minorUnitsToAmount(10, 'JPY')).toBe(10)
  })
})
