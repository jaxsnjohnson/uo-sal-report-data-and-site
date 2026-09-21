// Shared by the worker and fallback so their search behavior stays identical.
export const normalize = value => String(value ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase();

function payMatches(value, expression) {
  if (value == null) return false;
  const number = input => Number(input.replace(/k$/i, '')) * (/k$/i.test(input) ? 1000 : 1);
  const range = expression.match(/^(\d+(?:\.\d+)?k?)-(\d+(?:\.\d+)?k?)$/i);
  if (range) return value >= number(range[1]) && value <= number(range[2]);
  const compare = expression.match(/^(>=|<=|>|<|=)?(-?\d+(?:\.\d+)?k?)$/i);
  if (!compare) throw new Error('Use pay:60k-90k, pay:>100k, or pay:50000.');
  const target = number(compare[2]);
  return ({'>': value > target, '<': value < target, '>=': value >= target, '<=': value <= target, '=': value === target})[compare[1] || '='];
}

export function searchRecords(records, filters) {
  const tokens = (filters.query.match(/(?:[^\s"]+|"[^"]*")+/g) || []).map(value => value.replaceAll('"', ''));
  const predicates = tokens.map(token => {
    const exclude = token.startsWith('-');
    const raw = exclude ? token.slice(1) : token;
    const split = raw.indexOf(':');
    const field = split < 0 ? '' : raw.slice(0, split).toLowerCase();
    const value = split < 0 ? raw : raw.slice(split + 1);
    if (field && !['name', 'org', 'role', 'type', 'pay'].includes(field)) throw new Error(`Unknown search field “${field}”. See Search tips.`);
    if (field === 'pay') payMatches(0, value); // Validate even when the population is empty.
    return record => {
      const fields = {name: record.name, org: record.department, role: record.title, type: record.classification};
      const match = field === 'pay' ? record.usable && payMatches(record.amount, value)
        : field === 'type' ? normalize(record.classification) === normalize(value)
        : normalize(field ? fields[field] : `${record.name} ${record.department} ${record.title}`).includes(normalize(value));
      return exclude ? !match : match;
    };
  });
  if (filters.min !== '' && filters.max !== '' && Number(filters.min) > Number(filters.max)) throw new Error('Minimum pay must not exceed maximum pay.');
  const result = records.filter(row => row.kind === filters.kind && row.date === filters.period && row.measure === filters.measure
    && (filters.classification === 'all' || row.classification === filters.classification)
    && (!filters.fullTime || row.fte != null && row.fte >= 1)
    && (!filters.flagged || !row.usable)
    && (filters.min === '' || row.usable && row.amount >= Number(filters.min))
    && (filters.max === '' || row.usable && row.amount <= Number(filters.max))
    && predicates.every(predicate => predicate(row)));
  result.sort((a, b) => {
    if (filters.sort === 'name-desc') return b.name.localeCompare(a.name) || a.id.localeCompare(b.id);
    if (filters.sort !== 'name') {
      if (a.usable !== b.usable) return a.usable ? -1 : 1;
      if (a.usable && a.amount !== b.amount) return filters.sort === 'pay-desc' ? b.amount - a.amount : a.amount - b.amount;
    }
    return a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
  });
  return result.map(row => row.id);
}
