// src/rpgmaker-battle/formula.ts — safe RPG Maker damage-formula subset.
//
// RPG Maker stores damage formulas as arbitrary JavaScript. Imported games
// must never execute that source, so this module tokenizes it into a small
// JSON AST and evaluates only explicitly allowlisted syntax. The importer can
// persist the AST and report every rejected formula before a game is shipped.

export const RPGMAKER_FORMULA_FALLBACK = "Math.max(0, a.atk * 4 - b.def * 2)";

export const RPGMAKER_BATTLER_PARAMS = [
  "hp", "mp", "tp", "mhp", "mmp", "atk", "def", "mat", "mdf", "agi", "luk", "level",
] as const;

export type RpgMakerBattlerParam = typeof RPGMAKER_BATTLER_PARAMS[number];

export type RpgMakerFormulaNode =
  | { kind: "number"; value: number }
  | { kind: "param"; side: "a" | "b"; name: RpgMakerBattlerParam }
  | { kind: "variable"; index: number }
  | { kind: "mathConst"; name: "E" | "PI" }
  | { kind: "group"; value: RpgMakerFormulaNode }
  | { kind: "unary"; op: "+" | "-" | "!"; value: RpgMakerFormulaNode }
  | {
      kind: "binary";
      op: "+" | "-" | "*" | "/" | "%" | "**" | "<" | "<=" | ">" | ">=" |
        "==" | "!=" | "===" | "!==" | "&&" | "||";
      left: RpgMakerFormulaNode;
      right: RpgMakerFormulaNode;
    }
  | { kind: "ternary"; test: RpgMakerFormulaNode; yes: RpgMakerFormulaNode; no: RpgMakerFormulaNode }
  | { kind: "math"; name: RpgMakerMathFunction; args: RpgMakerFormulaNode[] };

const MATH_FUNCTIONS = [
  "abs", "ceil", "floor", "round", "trunc", "sign", "sqrt", "cbrt",
  "min", "max", "pow", "hypot", "sin", "cos", "tan", "asin", "acos", "atan", "atan2",
] as const;

export type RpgMakerMathFunction = typeof MATH_FUNCTIONS[number];

const PARAMS = new Set<string>(RPGMAKER_BATTLER_PARAMS);
const MATH = new Set<string>(MATH_FUNCTIONS);
const MAX_SOURCE_LENGTH = 2_048;
const MAX_TOKENS = 512;
const MAX_DEPTH = 64;
const MAX_MATH_ARGS = 32;

type TokenKind = "number" | "ident" | "op" | "eof";
interface Token {
  kind: TokenKind;
  text: string;
  offset: number;
}

export class RpgMakerFormulaError extends Error {
  constructor(readonly offset: number, message: string) {
    super(`formula at ${offset}: ${message}`);
    this.name = "RpgMakerFormulaError";
  }
}

const TWO_CHAR = new Set(["<=", ">=", "==", "!=", "&&", "||", "**"]);
const THREE_CHAR = new Set(["===", "!=="]);
const ONE_CHAR = new Set(["+", "-", "*", "/", "%", "<", ">", "!", "?", ":", ".", "[", "]", "(", ")", ","]);

function tokenize(source: string): Token[] {
  if (source.length > MAX_SOURCE_LENGTH) {
    throw new RpgMakerFormulaError(MAX_SOURCE_LENGTH, `formula exceeds ${MAX_SOURCE_LENGTH} characters`);
  }
  const out: Token[] = [];
  const add = (token: Token): void => {
    out.push(token);
    if (out.length > MAX_TOKENS) {
      throw new RpgMakerFormulaError(token.offset, `formula exceeds ${MAX_TOKENS} tokens`);
    }
  };
  let i = 0;
  while (i < source.length) {
    const c = source[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(source[i + 1] ?? ""))) {
      const start = i;
      if (c !== ".") while (/[0-9]/.test(source[i] ?? "")) i++;
      if (source[i] === ".") {
        i++;
        while (/[0-9]/.test(source[i] ?? "")) i++;
      }
      if ((source[i] ?? "").toLowerCase() === "e") {
        const exponent = i++;
        if (source[i] === "+" || source[i] === "-") i++;
        const digits = i;
        while (/[0-9]/.test(source[i] ?? "")) i++;
        if (digits === i) throw new RpgMakerFormulaError(exponent, "malformed exponent");
      }
      const text = source.slice(start, i);
      const value = Number(text);
      if (!Number.isFinite(value)) throw new RpgMakerFormulaError(start, "finite numeric literal required");
      add({ kind: "number", text, offset: start });
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      const start = i++;
      while (/[A-Za-z0-9_$]/.test(source[i] ?? "")) i++;
      add({ kind: "ident", text: source.slice(start, i), offset: start });
      continue;
    }
    const three = source.slice(i, i + 3);
    if (THREE_CHAR.has(three)) {
      add({ kind: "op", text: three, offset: i });
      i += 3;
      continue;
    }
    const two = source.slice(i, i + 2);
    if (TWO_CHAR.has(two)) {
      add({ kind: "op", text: two, offset: i });
      i += 2;
      continue;
    }
    if (ONE_CHAR.has(c)) {
      add({ kind: "op", text: c, offset: i++ });
      continue;
    }
    throw new RpgMakerFormulaError(i, `unsupported token ${JSON.stringify(c)}`);
  }
  add({ kind: "eof", text: "", offset: source.length });
  return out;
}

const BINARY_PRECEDENCE: Readonly<Record<string, number>> = {
  "||": 1,
  "&&": 2,
  "==": 3,
  "!=": 3,
  "===": 3,
  "!==": 3,
  "<": 4,
  "<=": 4,
  ">": 4,
  ">=": 4,
  "+": 5,
  "-": 5,
  "*": 6,
  "/": 6,
  "%": 6,
  "**": 7,
};

class Parser {
  private at = 0;

  constructor(private readonly source: string, private readonly tokens: readonly Token[]) {}

  parse(): RpgMakerFormulaNode {
    if (this.peek().kind === "eof") throw new RpgMakerFormulaError(0, "formula is empty");
    const result = this.ternary();
    const tail = this.peek();
    if (tail.kind !== "eof") throw new RpgMakerFormulaError(tail.offset, `unexpected ${JSON.stringify(tail.text)}`);
    return result;
  }

  private peek(): Token {
    return this.tokens[this.at]!;
  }

  private take(text?: string): Token {
    const token = this.peek();
    if (text !== undefined && token.text !== text) {
      throw new RpgMakerFormulaError(token.offset, `expected ${JSON.stringify(text)}, got ${JSON.stringify(token.text)}`);
    }
    this.at++;
    return token;
  }

  private ternary(): RpgMakerFormulaNode {
    const test = this.binary(1);
    if (this.peek().text !== "?") return test;
    this.take("?");
    const yes = this.ternary();
    this.take(":");
    const no = this.ternary();
    return { kind: "ternary", test, yes, no };
  }

  private binary(minPrecedence: number): RpgMakerFormulaNode {
    let left = this.unary();
    for (;;) {
      const operator = this.peek();
      const precedence = BINARY_PRECEDENCE[operator.text];
      if (precedence === undefined || precedence < minPrecedence) return left;
      this.take();
      if (operator.text === "**" && left.kind === "unary") {
        throw new RpgMakerFormulaError(operator.offset, "JavaScript requires parentheses before ** after a unary operator");
      }
      const right = this.binary(operator.text === "**" ? precedence : precedence + 1);
      left = {
        kind: "binary",
        op: operator.text as Extract<RpgMakerFormulaNode, { kind: "binary" }>["op"],
        left,
        right,
      };
    }
  }

  private unary(): RpgMakerFormulaNode {
    const token = this.peek();
    if (token.text === "+" || token.text === "-" || token.text === "!") {
      this.take();
      return { kind: "unary", op: token.text, value: this.unary() };
    }
    return this.primary();
  }

  private primary(): RpgMakerFormulaNode {
    const token = this.peek();
    if (token.kind === "number") {
      this.take();
      return { kind: "number", value: Number(token.text) };
    }
    if (token.text === "(") {
      this.take();
      const value = this.ternary();
      this.take(")");
      return { kind: "group", value };
    }
    if (token.kind !== "ident") {
      throw new RpgMakerFormulaError(token.offset, `expected a number, battler parameter, variable, or Math call`);
    }
    if (token.text === "a" || token.text === "b") return this.battler();
    if (token.text === "v") return this.variable();
    if (token.text === "Math") return this.math();
    throw new RpgMakerFormulaError(token.offset, `identifier ${JSON.stringify(token.text)} is outside the safe subset`);
  }

  private battler(): RpgMakerFormulaNode {
    const side = this.take().text as "a" | "b";
    this.take(".");
    const name = this.take();
    if (name.kind !== "ident" || !PARAMS.has(name.text)) {
      throw new RpgMakerFormulaError(name.offset, `unsupported ${side} parameter ${JSON.stringify(name.text)}`);
    }
    return { kind: "param", side, name: name.text as RpgMakerBattlerParam };
  }

  private variable(): RpgMakerFormulaNode {
    this.take("v");
    this.take("[");
    const index = this.take();
    if (index.kind !== "number" || !Number.isSafeInteger(Number(index.text)) || Number(index.text) < 0) {
      throw new RpgMakerFormulaError(index.offset, "v index must be a non-negative integer literal");
    }
    this.take("]");
    return { kind: "variable", index: Number(index.text) };
  }

  private math(): RpgMakerFormulaNode {
    this.take("Math");
    this.take(".");
    const member = this.take();
    if (member.kind !== "ident") throw new RpgMakerFormulaError(member.offset, "Math member name required");
    if ((member.text === "PI" || member.text === "E") && this.peek().text !== "(") {
      return { kind: "mathConst", name: member.text };
    }
    if (!MATH.has(member.text)) {
      throw new RpgMakerFormulaError(member.offset, `Math.${member.text} is outside the safe subset`);
    }
    this.take("(");
    const args: RpgMakerFormulaNode[] = [];
    if (this.peek().text !== ")") {
      for (;;) {
        args.push(this.ternary());
        if (args.length > MAX_MATH_ARGS) {
          throw new RpgMakerFormulaError(member.offset, `Math calls support at most ${MAX_MATH_ARGS} arguments`);
        }
        if (this.peek().text !== ",") break;
        this.take(",");
      }
    }
    this.take(")");
    return { kind: "math", name: member.text as RpgMakerMathFunction, args };
  }
}

export function parseRpgMakerFormula(source: string): RpgMakerFormulaNode {
  return new Parser(source, tokenize(source)).parse();
}

export interface RpgMakerFormulaBattler extends Record<RpgMakerBattlerParam, number> {}

export interface RpgMakerFormulaContext {
  a: RpgMakerFormulaBattler;
  b: RpgMakerFormulaBattler;
  /** Numeric RPG Maker variable ids. A missing value behaves like the
   * undefined hole in $gameVariables._data, making arithmetic NaN and the
   * final formula result zero. */
  variables?: Readonly<Record<number, number>> | readonly number[];
}

type FormulaValue = number | boolean | undefined;

const truthy = (value: FormulaValue): boolean => Boolean(value);

function variableAt(values: RpgMakerFormulaContext["variables"], index: number): number | undefined {
  if (values === undefined) return undefined;
  const value = values[index];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function mathCall(name: RpgMakerMathFunction, args: FormulaValue[]): number {
  const numbers = args as (number | undefined)[];
  switch (name) {
    case "abs": return Math.abs(numbers[0] as number);
    case "ceil": return Math.ceil(numbers[0] as number);
    case "floor": return Math.floor(numbers[0] as number);
    case "round": return Math.round(numbers[0] as number);
    case "trunc": return Math.trunc(numbers[0] as number);
    case "sign": return Math.sign(numbers[0] as number);
    case "sqrt": return Math.sqrt(numbers[0] as number);
    case "cbrt": return Math.cbrt(numbers[0] as number);
    case "min": return Math.min(...numbers as number[]);
    case "max": return Math.max(...numbers as number[]);
    case "pow": return Math.pow(numbers[0] as number, numbers[1] as number);
    case "hypot": return Math.hypot(...numbers as number[]);
    case "sin": return Math.sin(numbers[0] as number);
    case "cos": return Math.cos(numbers[0] as number);
    case "tan": return Math.tan(numbers[0] as number);
    case "asin": return Math.asin(numbers[0] as number);
    case "acos": return Math.acos(numbers[0] as number);
    case "atan": return Math.atan(numbers[0] as number);
    case "atan2": return Math.atan2(numbers[0] as number, numbers[1] as number);
  }
}

function evaluate(
  node: RpgMakerFormulaNode,
  context: RpgMakerFormulaContext,
  budget: { nodes: number },
  depth: number,
): FormulaValue {
  if (depth > MAX_DEPTH || --budget.nodes < 0) throw new Error("formula AST exceeds safe evaluation limits");
  const child = (value: RpgMakerFormulaNode): FormulaValue => evaluate(value, context, budget, depth + 1);
  switch (node.kind) {
    case "number": return node.value;
    case "param": return context[node.side][node.name];
    case "variable": return variableAt(context.variables, node.index);
    case "mathConst": return node.name === "PI" ? Math.PI : Math.E;
    case "group": return child(node.value);
    case "unary": {
      const value = child(node.value);
      if (node.op === "+") return +(value as number | boolean);
      if (node.op === "-") return -(value as number | boolean);
      return !truthy(value);
    }
    case "binary": {
      const left = child(node.left);
      if (node.op === "&&") return truthy(left) ? child(node.right) : left;
      if (node.op === "||") return truthy(left) ? left : child(node.right);
      const right = child(node.right);
      switch (node.op) {
        case "+": return Number(left) + Number(right);
        case "-": return Number(left) - Number(right);
        case "*": return Number(left) * Number(right);
        case "/": return Number(left) / Number(right);
        case "%": return Number(left) % Number(right);
        case "**": return Number(left) ** Number(right);
        case "<": return Number(left) < Number(right);
        case "<=": return Number(left) <= Number(right);
        case ">": return Number(left) > Number(right);
        case ">=": return Number(left) >= Number(right);
        case "==": return left === right ||
          (left !== undefined && right !== undefined && Number(left) === Number(right));
        case "===": return left === right;
        case "!=": return !(left === right ||
          (left !== undefined && right !== undefined && Number(left) === Number(right)));
        case "!==": return left !== right;
      }
      break;
    }
    case "ternary": return truthy(child(node.test)) ? child(node.yes) : child(node.no);
    case "math": return mathCall(node.name, node.args.map(child));
  }
  throw new Error("invalid formula AST");
}

/** Evaluate a previously parsed raw expression. Invalid/forged ASTs, NaN and
 * Infinity become zero. Refusing Infinity is an intentional JSON-state safety
 * tightening over corescript's isNaN-only check. */
export function evaluateRpgMakerFormula(
  formula: RpgMakerFormulaNode,
  context: RpgMakerFormulaContext,
): number {
  try {
    const value = evaluate(formula, context, { nodes: MAX_TOKENS }, 0);
    const numeric = typeof value === "boolean" ? (value ? 1 : 0) : value;
    return typeof numeric === "number" && Number.isFinite(numeric) ? numeric : 0;
  } catch {
    return 0;
  }
}

/** Apply corescript's base-value rule after raw expression evaluation.
 * Element, critical, variance and guard remain later pipeline stages. */
export function evaluateRpgMakerDamageBase(
  formula: RpgMakerFormulaNode,
  type: number,
  context: RpgMakerFormulaContext,
): number {
  const magnitude = Math.max(evaluateRpgMakerFormula(formula, context), 0);
  return type === 3 || type === 4 ? -magnitude : magnitude;
}

