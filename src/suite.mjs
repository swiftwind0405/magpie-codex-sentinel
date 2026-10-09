/** Deterministic, original probes with local oracles. No model output is executed. */
export const SUITE_VERSION = 'sentinel-v1';

const FAMILIES = ['candy', 'js-trace', 'constraint'];
const DEFAULT_SEED = 'sentinel-default';

function randomFor(seed) {
  let state = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    state = Math.imul(state ^ seed.charCodeAt(index), 16777619) >>> 0;
  }
  return {
    int(minimum, maximum) {
      state = (state + 0x6d2b79f5) >>> 0;
      let value = state;
      value = Math.imul(value ^ (value >>> 15), value | 1);
      value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
      const unit = ((value ^ (value >>> 14)) >>> 0) / 4294967296;
      return minimum + Math.floor(unit * (maximum - minimum + 1));
    },
  };
}

function shuffle(values, random) {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const other = random.int(0, index);
    [result[index], result[other]] = [result[other], result[index]];
  }
  return result;
}

function answerInstructions(type) {
  return `不调用任何工具，不运行代码。只输出一个 JSON 对象，使用 answer 字段，answer 必须是${type}。不要解释或添加 Markdown。`;
}

/**
 * A losing selection occupies at least one of four rectangles in (round, star):
 * no relevant round candy, no relevant star candy, no apples, or no peaches.
 * The first two require r > c and s > f. The other two change their required s
 * only when r passes b+c or a+c, so only three corner candidates are needed.
 * Inventory may contain zeroes. A null minimum means success is impossible.
 */
export function candyOracle(round, star) {
  for (const counts of [round, star]) {
    if (!Array.isArray(counts) || counts.length !== 3
      || counts.some((count) => !Number.isSafeInteger(count) || count < 0)) {
      throw new TypeError('糖果库存必须是包含三个非负安全整数的数组。');
    }
  }
  const [a, b, c] = round;
  const [d, e, f] = star;
  const roundTotal = a + b + c;
  const starTotal = d + e + f;
  if (!Number.isSafeInteger(roundTotal + starTotal)) {
    throw new RangeError('糖果库存总数超出安全整数范围。');
  }
  let minimum = null;
  let plans = [];
  const candidates = [...new Set([c + 1, b + c + 1, a + c + 1])]
    .filter((count) => count <= roundTotal)
    .sort((left, right) => left - right);
  for (const r of candidates) {
    const s = Math.max(
      f + 1,
      r <= b + c ? e + f + 1 : 0,
      r <= a + c ? d + f + 1 : 0,
    );
    if (s > starTotal) continue;
    const total = r + s;
    if (minimum === null || total < minimum) {
      minimum = total;
      plans = [{ round: r, star: s }];
    } else if (total === minimum) {
      plans.push({ round: r, star: s });
    }
  }
  return { minimum, plans };
}

function buildCandy(random) {
  const round = Array.from({ length: 3 }, () => random.int(2, 10));
  const star = Array.from({ length: 3 }, () => random.int(2, 10));
  const expected = candyOracle(round, star).minimum;
  const prompt = `一个不透明盒子中有两种形状、三种口味的糖果，库存如下：

形状 | 苹果味 | 桃子味 | 西瓜味
圆形 | ${round.join(' | ')}
星形 | ${star.join(' | ')}

你可以在盒子内用手感识别并选择形状，但完全不能识别口味。你必须事先确定取出 r 个圆形和 s 个星形；两种形状内具体取到哪些口味由最不利情况决定。取出后不能放回，也不能根据已取出的口味改变配额。r、s 是不超过各自库存总量的非负整数。

目标是保证取出的糖果中，至少存在一对“圆形苹果味与星形桃子味”，或者一对“圆形桃子味与星形苹果味”。在可以自行选择固定配额 r、s 的前提下，r+s 的最小值是多少？

${answerInstructions('一个整数，表示最小总数量')}`;
  return { prompt, expected };
}

function buildTrace(random, index) {
  const numbers = (count, low = 1, high = 12) =>
    Array.from({ length: count }, () => random.int(low, high));
  let code;
  let expected;
  switch (index % 6) {
    case 0: {
      const [a, b, c, delta] = numbers(4);
      code = `const a = [${a}, ${b}, ${c}];
const b = a;
const c = [...a];
b[1] += ${delta};
c.push(a.shift());
const out = [a.length, a[0], b[1], c.reduce((sum, n) => sum + n, 0)];
console.log(JSON.stringify(out));`;
      expected = [2, b + delta, c, 2 * a + b + c];
      break;
    }
    case 1: {
      const values = numbers(5);
      const start = random.int(3, 12);
      let final = start;
      let keptCount = 0;
      let keptSum = 0;
      for (let position = 0; position < values.length; position += 1) {
        final += position % 2 === 0 ? values[position] : -values[position];
        if (final % 3 !== 0) {
          keptCount += 1;
          keptSum += final;
        }
      }
      code = `const values = ${JSON.stringify(values)};
let acc = ${start};
const kept = values.map((value, index) => {
  acc += index % 2 === 0 ? value : -value;
  return acc;
}).filter(value => value % 3 !== 0);
const out = [acc, kept.length, kept.reduce((sum, value) => sum + value, 0)];
console.log(JSON.stringify(out));`;
      expected = [final, keptCount, keptSum];
      break;
    }
    case 2: {
      const [a, b, delta, step] = numbers(4);
      const factor = random.int(2, 4);
      code = `const base = { n: ${a}, inner: { n: ${b} } };
const copy = { ...base };
copy.n += ${delta};
copy.inner.n *= ${factor};
const arr = [base, copy];
arr[0] = { ...arr[0], n: arr[1].n + ${step} };
const out = [base.n, base.inner.n, copy.n, arr[0].n, arr[0].inner === copy.inner ? 1 : 0];
console.log(JSON.stringify(out));`;
      expected = [a, b * factor, a + delta, a + delta + step, 1];
      break;
    }
    case 3: {
      const start = random.int(2, 15);
      const factor = random.int(2, 5);
      const modulus = random.int(11, 23);
      const steps = random.int(4, 7);
      let value = start;
      let total = 0;
      for (let step = 1; step <= steps; step += 1) {
        value = (value * factor + step) % modulus;
        total += value % 2 === 0 ? value : -step;
      }
      code = `let x = ${start};
let sum = 0;
for (let i = 1; i <= ${steps}; i += 1) {
  x = (x * ${factor} + i) % ${modulus};
  if (x % 2 === 0) sum += x;
  else sum -= i;
}
console.log(JSON.stringify([x, sum]));`;
      expected = [value, total];
      break;
    }
    case 4: {
      const [a, b, c, d, inserted, delta] = numbers(6);
      code = `const values = [${a}, ${b}, ${c}, ${d}];
const removed = values.splice(1, 2, ${inserted});
const snapshot = values.slice();
removed.reverse();
values.push(removed.shift());
snapshot[0] += ${delta};
const out = [...values, ...removed, snapshot[0], snapshot.length];
console.log(JSON.stringify(out));`;
      expected = [a, inserted, d, c, b, a + delta, 3];
      break;
    }
    default: {
      const values = numbers(6);
      // Select lexicographic minima directly instead of executing the prompt.
      const remaining = values.map((value, position) => ({ value, position }));
      expected = [];
      while (expected.length < 4) {
        let best = 0;
        for (let position = 1; position < remaining.length; position += 1) {
          const candidate = remaining[position];
          const current = remaining[best];
          const difference = (candidate.value % 3) - (current.value % 3)
            || current.value - candidate.value || candidate.position - current.position;
          if (difference < 0) best = position;
        }
        const [selected] = remaining.splice(best, 1);
        expected.push(selected.value + selected.position);
      }
      code = `const values = ${JSON.stringify(values)};
const records = values.map((value, index) => ({ value, index }));
records.sort((a, b) => (a.value % 3) - (b.value % 3) || b.value - a.value || a.index - b.index);
const out = records.slice(0, 4).map(({ value, index }) => value + index);
console.log(JSON.stringify(out));`;
      break;
    }
  }
  return {
    prompt: `按标准 JavaScript 语义，以下代码只执行一次。最后 console.log 输出的数组是什么？

\`\`\`javascript
${code}
\`\`\`

${answerInstructions('整数数组，顺序与代码输出一致')}`,
    expected,
  };
}

function permutations(values) {
  if (values.length === 0) return [[]];
  return values.flatMap((value, index) =>
    permutations(values.filter((_, other) => other !== index))
      .map((remaining) => [value, ...remaining]));
}

function chooseClues(candidates, solutions, random) {
  const remaining = shuffle(candidates, random);
  const clues = [];
  while (solutions.length > 1) {
    let bestIndex = -1;
    let bestSolutions = solutions;
    for (let index = 0; index < remaining.length; index += 1) {
      const survivors = solutions.filter(remaining[index].matches);
      if (survivors.length > 0 && survivors.length < bestSolutions.length) {
        bestIndex = index;
        bestSolutions = survivors;
      }
    }
    if (bestIndex === -1) throw new Error('内部题库错误：约束未能确定唯一解。');
    clues.push(remaining.splice(bestIndex, 1)[0]);
    solutions = bestSolutions;
  }
  // Keep a small, consistent reading load even for unusually strong clues.
  while (clues.length < 4 && remaining.length > 0) clues.push(remaining.shift());
  return { clues, solution: solutions[0] };
}

function buildOrdering(random) {
  const labels = ['A', 'B', 'C', 'D', 'E'];
  const hidden = shuffle(labels, random);
  const position = (order, label) => order.indexOf(label) + 1;
  const candidates = [];
  for (let first = 0; first < labels.length; first += 1) {
    for (let second = first + 1; second < labels.length; second += 1) {
      const left = labels[first];
      const right = labels[second];
      const leftPosition = position(hidden, left);
      const rightPosition = position(hidden, right);
      const [earlier, later] = leftPosition < rightPosition ? [left, right] : [right, left];
      candidates.push({
        text: `${earlier} 排在 ${later} 前面，但不一定紧邻。`,
        matches: (order) => position(order, earlier) < position(order, later),
      });
      const distance = Math.abs(leftPosition - rightPosition);
      candidates.push({
        text: `${left} 与 ${right} 的位置编号之差的绝对值是 ${distance}。`,
        matches: (order) => Math.abs(position(order, left) - position(order, right)) === distance,
      });
      const sum = leftPosition + rightPosition;
      candidates.push({
        text: `${left} 与 ${right} 的位置编号之和是 ${sum}。`,
        matches: (order) => position(order, left) + position(order, right) === sum,
      });
    }
  }
  const { clues, solution } = chooseClues(candidates, permutations(labels), random);
  return {
    prompt: `A、B、C、D、E 五个人各占一个位置，排成一列。位置从前到后编号为 1 至 5，每个位置恰好一人。以下条件全部成立：

${clues.map((clue, index) => `${index + 1}. ${clue.text}`).join('\n')}

求唯一的从前到后顺序，将五个大写字母直接连写，不加空格或分隔符。

${answerInstructions('包含五个大写字母的字符串')}`,
    expected: solution.join(''),
  };
}

function buildSwitches(random) {
  const labels = ['A', 'B', 'C', 'D', 'E'];
  const enabledCount = random.int(2, 3);
  const enabled = new Set(shuffle(labels, random).slice(0, enabledCount));
  const hidden = labels.map((label) => enabled.has(label) ? 1 : 0);
  const solutions = Array.from({ length: 32 }, (_, mask) =>
    labels.map((_, index) => (mask >> index) & 1))
    .filter((bits) => bits.reduce((sum, bit) => sum + bit, 0) === enabledCount);
  const candidates = [];
  for (let first = 0; first < labels.length; first += 1) {
    for (let second = first + 1; second < labels.length; second += 1) {
      const left = labels[first];
      const right = labels[second];
      const different = hidden[first] !== hidden[second];
      candidates.push({
        text: different ? `${left} 与 ${right} 中恰好一个开启。` : `${left} 与 ${right} 的开关状态相同。`,
        matches: (bits) => (bits[first] !== bits[second]) === different,
      });
      if (hidden[first] || hidden[second]) candidates.push({
        text: `${left} 与 ${right} 至少一个开启，也允许两个都开启。`,
        matches: (bits) => Boolean(bits[first] || bits[second]),
      });
      if (!(hidden[first] && hidden[second])) candidates.push({
        text: `${left} 与 ${right} 不能同时开启。`,
        matches: (bits) => !(bits[first] && bits[second]),
      });
      for (const [antecedent, consequent] of [[first, second], [second, first]]) {
        if (!hidden[antecedent] || hidden[consequent]) candidates.push({
          text: `如果 ${labels[antecedent]} 开启，则 ${labels[consequent]} 必须开启；前者关闭时这条条件不限制后者。`,
          matches: (bits) => !bits[antecedent] || Boolean(bits[consequent]),
        });
      }
    }
  }
  const { clues, solution } = chooseClues(candidates, solutions, random);
  return {
    prompt: `有 A、B、C、D、E 五个开关，每个只能开启或关闭。其中恰好 ${enabledCount} 个开启，且以下条件全部成立：

${clues.map((clue, index) => `${index + 1}. ${clue.text}`).join('\n')}

求唯一的开关状态。按 A、B、C、D、E 的顺序，用 1 表示开启、0 表示关闭，连写成五位字符串，必须保留开头的 0。

${answerInstructions('由 0 和 1 组成的五位字符串')}`,
    expected: solution.join(''),
  };
}

export function buildSuite({ profile = 'quick', seed = DEFAULT_SEED } = {}) {
  if (!['quick', 'standard'].includes(profile)) throw new TypeError('profile 必须是 quick 或 standard。');
  if (typeof seed !== 'string') throw new TypeError('seed 必须是字符串。');
  const perFamily = profile === 'quick' ? 2 : 6;
  const cases = [];
  for (let index = 0; index < perFamily; index += 1) {
    for (const family of FAMILIES) {
      const random = randomFor(`${SUITE_VERSION}\u0000${seed}\u0000${family}\u0000${index}`);
      const question = family === 'candy' ? buildCandy(random)
        : family === 'js-trace' ? buildTrace(random, index)
          : index % 2 === 0 ? buildOrdering(random) : buildSwitches(random);
      cases.push({ id: `${family}-${String(index + 1).padStart(2, '0')}`, family, ...question });
    }
  }
  return cases;
}

function sameType(actual, expected) {
  if (expected === null) return actual === null;
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && actual.every((value, index) =>
      expected.length === 0 || sameType(value, index < expected.length ? expected[index] : expected[0]));
  }
  if (typeof expected === 'number') return typeof actual === 'number' && Number.isFinite(actual);
  if (typeof expected === 'object') {
    return actual !== null && typeof actual === 'object' && !Array.isArray(actual)
      && Object.keys(expected).every((key) => Object.hasOwn(actual, key) && sameType(actual[key], expected[key]));
  }
  return typeof actual === typeof expected;
}

function sameAnswer(actual, expected) {
  if (actual === expected) return true;
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && actual.length === expected.length
      && expected.every((value, index) => sameAnswer(actual[index], value));
  }
  if (expected !== null && typeof expected === 'object') {
    return actual !== null && typeof actual === 'object' && !Array.isArray(actual)
      && Object.keys(actual).length === Object.keys(expected).length
      && Object.keys(expected).every((key) => Object.hasOwn(actual, key) && sameAnswer(actual[key], expected[key]));
  }
  return false;
}

export function gradeCase(testCase, text) {
  if (!testCase || !Object.hasOwn(testCase, 'expected')) throw new TypeError('测试题缺少 expected。');
  const invalid = (reason, answer = null) => ({ passed: false, formatValid: false, answer, reason });
  if (typeof text !== 'string') return invalid('模型输出必须是文本。');
  let source = text.trim();
  if (source.startsWith('```')) {
    const fence = /^```json[ \t]*\r?\n([\s\S]*?)\r?\n```$/i.exec(source);
    if (!fence) return invalid('仅接受完整 JSON 或包裹它的单个 json 代码块。');
    source = fence[1].trim();
  }
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch {
    return invalid('输出不是一个完整、有效的 JSON 对象。');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) || !Object.hasOwn(parsed, 'answer')) {
    return invalid('JSON 顶层必须是含 answer 字段的对象。');
  }
  if (!sameType(parsed.answer, testCase.expected)) return invalid('answer 类型不符合题目要求。', parsed.answer);
  const passed = sameAnswer(parsed.answer, testCase.expected);
  return {
    passed,
    formatValid: true,
    answer: parsed.answer,
    reason: passed ? '答案与本地确定性验证结果一致。' : '答案与本地确定性验证结果不一致。',
  };
}
