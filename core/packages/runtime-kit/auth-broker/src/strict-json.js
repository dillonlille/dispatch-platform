'use strict';

class StrictJsonError extends Error {
  constructor() {
    super('invalid_json');
    this.code = 'invalid_json';
  }
}

function parseStrictJson(raw) {
  if (typeof raw !== 'string') throw new StrictJsonError();
  let offset = 0;
  const whitespace = () => { while (' \t\r\n'.includes(raw[offset] || '\0')) offset += 1; };
  const fail = () => { throw new StrictJsonError(); };
  const parseString = () => {
    if (raw[offset] !== '"') fail();
    const start = offset++;
    while (offset < raw.length) {
      const character = raw[offset];
      if (character === '"') {
        offset += 1;
        try { return JSON.parse(raw.slice(start, offset)); } catch { fail(); }
      }
      if (character === '\\') {
        offset += 1;
        if (offset >= raw.length) fail();
        if (raw[offset] === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(raw.slice(offset + 1, offset + 5))) fail();
          offset += 5;
          continue;
        }
        if (!'"\\/bfnrt'.includes(raw[offset])) fail();
      } else if (character.charCodeAt(0) < 0x20) fail();
      offset += 1;
    }
    fail();
  };
  const parseValue = () => {
    whitespace();
    const character = raw[offset];
    if (character === '{') {
      offset += 1;
      const result = {};
      const keys = new Set();
      whitespace();
      if (raw[offset] === '}') { offset += 1; return result; }
      while (offset < raw.length) {
        whitespace();
        const key = parseString();
        if (keys.has(key)) fail();
        keys.add(key);
        whitespace();
        if (raw[offset] !== ':') fail();
        offset += 1;
        const parsed = parseValue();
        Object.defineProperty(result, key, { value: parsed, enumerable: true, writable: true, configurable: true });
        whitespace();
        if (raw[offset] === '}') { offset += 1; return result; }
        if (raw[offset] !== ',') fail();
        offset += 1;
      }
      fail();
    }
    if (character === '[') {
      offset += 1;
      const result = [];
      whitespace();
      if (raw[offset] === ']') { offset += 1; return result; }
      while (offset < raw.length) {
        result.push(parseValue());
        whitespace();
        if (raw[offset] === ']') { offset += 1; return result; }
        if (raw[offset] !== ',') fail();
        offset += 1;
      }
      fail();
    }
    if (character === '"') return parseString();
    for (const [literal, value] of [['true', true], ['false', false], ['null', null]]) {
      if (raw.startsWith(literal, offset)) { offset += literal.length; return value; }
    }
    const number = raw.slice(offset).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (!number) fail();
    offset += number[0].length;
    const value = Number(number[0]);
    if (!Number.isFinite(value)) fail();
    return value;
  };
  const value = parseValue();
  whitespace();
  if (offset !== raw.length) fail();
  return value;
}

module.exports = { StrictJsonError, parseStrictJson };
