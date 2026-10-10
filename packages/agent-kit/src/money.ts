// Stripe charge-unit rules: https://docs.stripe.com/currencies#zero-decimal
const ZERO_DECIMAL = new Set([
  'BIF',
  'CLP',
  'DJF',
  'GNF',
  'JPY',
  'KMF',
  'KRW',
  'MGA',
  'PYG',
  'RWF',
  'VND',
  'VUV',
  'XAF',
  'XOF',
  'XPF',
])
// Three-decimal currencies are charged in thousandths, and Stripe requires
// the amount to end in 0: https://docs.stripe.com/currencies#three-decimal
const THREE_DECIMAL = new Set(['BHD', 'JOD', 'KWD', 'OMR', 'TND'])
function chargeFactor(currency: string): number {
  const code = currency.toUpperCase()
  if (ZERO_DECIMAL.has(code)) return 1
  if (THREE_DECIMAL.has(code)) return 1000
  return 100
}
export function amountToMinorUnits(
  value: number | string,
  currency = 'USD'
): number {
  const amount = Number(value),
    code = currency.toUpperCase(),
    factor = chargeFactor(code)
  if (!Number.isFinite(amount) || amount < 0)
    throw new Error('Invalid payment amount')
  if (
    (factor === 1 || code === 'ISK' || code === 'UGX') &&
    !Number.isInteger(amount)
  )
    throw new Error(`${code} payments require a whole-currency amount`)
  const minor =
    factor === 1000
      ? Math.round((amount * factor) / 10) * 10
      : Math.round(amount * factor)
  if (!Number.isSafeInteger(minor))
    throw new Error('Payment amount is too large')
  return minor
}
export function minorUnitsToAmount(value: number, currency: string): number {
  if (!Number.isSafeInteger(value)) throw new Error('Invalid Stripe amount')
  return value / chargeFactor(currency)
}
