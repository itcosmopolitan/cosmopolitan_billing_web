export default function amountToWords(value, invalidFallback = 'ZERO RUFIYAA AND ZERO LAARI ONLY') {
  const number = Number(value ?? 0)
  if (Number.isNaN(number)) return invalidFallback

  const rupees = Math.floor(number)
  const laari = Math.round((number - rupees) * 100)
  const ones = [
    'ZERO', 'ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX', 'SEVEN',
    'EIGHT', 'NINE', 'TEN', 'ELEVEN', 'TWELVE', 'THIRTEEN',
    'FOURTEEN', 'FIFTEEN', 'SIXTEEN', 'SEVENTEEN', 'EIGHTEEN',
    'NINETEEN',
  ]
  const tens = [
    '', '', 'TWENTY', 'THIRTY', 'FORTY',
    'FIFTY', 'SIXTY', 'SEVENTY', 'EIGHTY', 'NINETY',
  ]

  const chunk = (number) => {
    if (number < 20) return ones[number]
    if (number < 100) {
      return tens[Math.floor(number / 10)] +
        (number % 10 ? ` ${ones[number % 10]}` : '')
    }
    const remainder = number % 100
    return `${ones[Math.floor(number / 100)]} HUNDRED${
      remainder ? ` ${chunk(remainder)}` : ''
    }`
  }

  if (rupees === 0 && laari === 0) {
    return 'ZERO RUFIYAA AND ZERO LAARI ONLY'
  }

  const parts = []
  let remaining = rupees
  let scaleIndex = 0
  const scale = ['', 'THOUSAND', 'MILLION', 'BILLION']

  while (remaining > 0) {
    const part = remaining % 1000
    if (part > 0) {
      parts.unshift(
        `${chunk(part)}${scale[scaleIndex] ? ` ${scale[scaleIndex]}` : ''}`
      )
    }
    remaining = Math.floor(remaining / 1000)
    scaleIndex += 1
  }

  return `${parts.join(' ') || 'ZERO'} RUFIYAA AND ${
    laari === 0 ? 'ZERO' : chunk(laari)
  } LAARI ONLY`
}