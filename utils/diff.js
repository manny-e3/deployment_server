/**
 * What an update changes, for audit details: { field: { from, to } }, only for fields that
 * actually change. Pass `fields` to limit which ones are compared.
 */
function diffFields(before, changes, fields = Object.keys(changes)) {
  return Object.fromEntries(
    fields
      .filter((f) => changes[f] !== undefined && changes[f] !== before[f])
      .map((f) => [f, { from: before[f] ?? null, to: changes[f] }]),
  );
}

module.exports = { diffFields };
