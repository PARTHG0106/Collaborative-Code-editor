// Complete-document text operations: positive numbers retain characters,
// negative numbers delete characters, strings insert text. Offsets use UTF-16,
// matching Monaco and JavaScript string indexing.
function append(operation, component) {
  if (component === 0 || component === '') return;
  const last = operation[operation.length - 1];
  if (typeof component === 'string' && typeof last === 'string') {
    operation[operation.length - 1] += component;
  } else if (typeof component === 'number' && typeof last === 'number' && Math.sign(component) === Math.sign(last)) {
    operation[operation.length - 1] += component;
  } else {
    operation.push(component);
  }
}

export function operationBaseLength(operation) {
  if (!Array.isArray(operation)) throw new Error('Invalid text operation');
  let length = 0;
  for (const component of operation) {
    if (typeof component === 'string') continue;
    if (!Number.isSafeInteger(component) || component === 0) throw new Error('Invalid text operation component');
    length += Math.abs(component);
    if (!Number.isSafeInteger(length)) throw new Error('Invalid text operation length');
  }
  return length;
}

export function applyOperation(content, operation) {
  if (operationBaseLength(operation) !== content.length) throw new Error('Text operation length does not match document');
  let cursor = 0;
  const result = [];
  for (const component of operation) {
    if (typeof component === 'string') result.push(component);
    else if (component > 0) {
      result.push(content.slice(cursor, cursor + component));
      cursor += component;
    } else cursor -= component;
  }
  return result.join('');
}

export function operationFromSplices(contentLength, edits) {
  if (!Number.isSafeInteger(contentLength) || contentLength < 0) throw new Error('Invalid document length');
  const operation = [];
  let cursor = 0;
  for (const edit of [...edits].sort((a, b) => a.offset - b.offset)) {
    if (!Number.isSafeInteger(edit.offset) || !Number.isSafeInteger(edit.length) ||
        edit.offset < cursor || edit.length < 0 || edit.offset + edit.length > contentLength ||
        typeof edit.text !== 'string') throw new Error('Invalid or overlapping text edits');
    append(operation, edit.offset - cursor);
    append(operation, edit.text);
    append(operation, -edit.length);
    cursor = edit.offset + edit.length;
  }
  append(operation, contentLength - cursor);
  return operation;
}

// Returns equivalent concurrent operations after each has seen the other.
// The left operation's inserted text comes first at an identical position.
export function transformOperations(left, right) {
  if (operationBaseLength(left) !== operationBaseLength(right)) throw new Error('Cannot transform operations with different base lengths');
  const leftPrime = [];
  const rightPrime = [];
  let li = 0;
  let ri = 0;
  let a = left[li++];
  let b = right[ri++];
  while (a !== undefined || b !== undefined) {
    if (typeof a === 'string') {
      append(leftPrime, a);
      append(rightPrime, a.length);
      a = left[li++];
      continue;
    }
    if (typeof b === 'string') {
      append(leftPrime, b.length);
      append(rightPrime, b);
      b = right[ri++];
      continue;
    }
    if (a === undefined || b === undefined) throw new Error('Invalid text operation lengths');
    const length = Math.min(Math.abs(a), Math.abs(b));
    if (a > 0 && b > 0) {
      append(leftPrime, length);
      append(rightPrime, length);
    } else if (a < 0 && b > 0) append(leftPrime, -length);
    else if (a > 0 && b < 0) append(rightPrime, -length);
    a += a > 0 ? -length : length;
    b += b > 0 ? -length : length;
    if (a === 0) a = left[li++];
    if (b === 0) b = right[ri++];
  }
  return [leftPrime, rightPrime];
}
