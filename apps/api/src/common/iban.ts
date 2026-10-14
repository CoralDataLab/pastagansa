export function normalizeIban(value?: string | null) {
  return value?.replace(/\s+/g, "").toUpperCase() || null;
}

export function isValidIban(iban: string) {
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  return mod97(`${iban.slice(4)}${iban.slice(0, 4)}`) === 1;
}

const CCC_WEIGHTS = [1, 2, 4, 8, 5, 10, 9, 7, 3, 6];

/** Spanish IBAN from the bank, branch and account of a CCC whose control digits are omitted (e.g. Norma 43). */
export function spanishIbanFromParts(bank: string, branch: string, account: string) {
  if (!/^\d{4}$/.test(bank) || !/^\d{4}$/.test(branch) || !/^\d{10}$/.test(account))
    return null;
  const bban = `${bank}${branch}${cccControlDigit(`00${bank}${branch}`)}${cccControlDigit(account)}${account}`;
  const checkDigits = String(98 - mod97(`${bban}ES00`)).padStart(2, "0");
  return `ES${checkDigits}${bban}`;
}

function cccControlDigit(digits: string) {
  const sum = [...digits].reduce(
    (total, digit, index) => total + Number(digit) * CCC_WEIGHTS[index],
    0,
  );
  const control = 11 - (sum % 11);
  return control === 11 ? 0 : control === 10 ? 1 : control;
}

function mod97(value: string) {
  let remainder = 0;
  for (const character of value) {
    const digits = /[A-Z]/.test(character)
      ? String(character.charCodeAt(0) - 55)
      : character;
    for (const digit of digits)
      remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder;
}
