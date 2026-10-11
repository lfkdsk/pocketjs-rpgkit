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
  const out: Token[] = [];
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
      out.push({ kind: "number", text, offset: start });
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      const start = i++;
      while (/[A-Za-z0-9_$]/.test(source[i] ?? "")) i++;
      out.push({ kind: "ident", text: source.slice(start, i), offset: start });
      continue;
    }
    const three = source.slice(i, i + 3);
    if (THREE_CHAR.has(three)) {
      out.push({ kind: "op", text: three, offset: i });
      i += 3;
      continue;
    }
    const two = source.slice(i, i + 2);
    if (TWO_CHAR.has(two)) {
      out.push({ kind: "op", text: two, offset: i });
      i += 2;
      continue;
    }
    if (ONE_CHAR.has(c)) {
      out.push({ kind: "op", text: c, offset: i++ });
      continue;
    }
    throw new RpgMakerFormulaError(i, `unsupported token ${JSON.stringify(c)}`);
  }
  out.push({ kind: "eof", text: "", offset: source.length });
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
      return value;
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
  /** Numeric RPG Maker variable ids. Missing and non-numeric values read 0. */
  variables?: Readonly<Record<number, number>> | readonly number[];
}

const truthy = (value: number): boolean => value !== 0 && !Number.isNaN(value);

function variableAt(values: RpgMakerFormulaContext["variables"], index: number): number {
  if (values === undefined) return 0;
  const value = values[index];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function mathCall(name: RpgMakerMathFunction, args: number[]): number {
  switch (name) {
    case "abs": return Math.abs(args[0] ?? 0);
    case "ceil": return Math.ceil(args[0] ?? 0);
    case "floor": return Math.floor(args[0] ?? 0);
    case "round": return Math.round(args[0] ?? 0);
    case "trunc": return Math.trunc(args[0] ?? 0);
    case "sign": return Math.sign(args[0] ?? 0);
    case "sqrt": return Math.sqrt(args[0] ?? 0);
    case "cbrt": return Math.cbrt(args[0] ?? 0);
    case "min": return Math.min(...args);
    case "max": return Math.max(...args);
    case "pow": return Math.pow(args[0] ?? 0, args[1] ?? 0);
    case "hypot": return Math.hypot(...args);
    case "sin": return Math.sin(args[0] ?? 0);
    case "cos": return Math.cos(args[0] ?? 0);
    case "tan": return Math.tan(args[0] ?? 0);
    case "asin": return Math.asin(args[0] ?? 0);
    case "acos": return Math.acos(args[0] ?? 0);
    case "atan": return Math.atan(args[0] ?? 0);
    case "atan2": return Math.atan2(args[0] ?? 0, args[1] ?? 0);
  }
}

function evaluate(node: RpgMakerFormulaNode, context: RpgMakerFormulaContext): number {
  switch (node.kind) {
    case "number": return node.value;
    case "param": return context[node.side][node.name];
    case "variable": return variableAt(context.variables, node.index);
    case "mathConst": return node.name === "PI" ? Math.PI : Math.E;
    case "unary": {
      const value = evaluate(node.value, context);
      if (node.op === "+") return value;
      if (node.op === "-") return -value;
      return truthy(value) ? 0 : 1;
    }
    case "binary": {
      const left = evaluate(node.left, context);
      if (node.op === "&&") return truthy(left) ? evaluate(node.right, context) : left;
      if (node.op === "||") return truthy(left) ? left : evaluate(node.right, context);
      const right = evaluate(node.right, context);
      switch (node.op) {
        case "+": return left + right;
        case "-": return left - right;
        case "*": return left * right;
        case "/": return left / right;
        case "%": return left % right;
        case "**": return left ** right;
        case "<": return left < right ? 1 : 0;
        case "<=": return left <= right ? 1 : 0;
        case ">": return left > right ? 1 : 0;
        case ">=": return left >= right ? 1 : 0;
        case "==":
        case "===": return left === right ? 1 : 0;
        case "!=":
        case "!==": return left !== right ? 1 : 0;
      }
      break;
    }
    case "ternary": return truthy(evaluate(node.test, context))
      ? evaluate(node.yes, context)
      : evaluate(node.no, context);
    case "math": return mathCall(node.name, node.args.map((arg) => evaluate(arg, context)));
  }
  return 0;
}

/** Evaluate a previously parsed formula. Non-finite JavaScript arithmetic
 * (division by zero, an invalid square root, overflow) follows RPG Maker's
 * catch-and-clamp behavior and becomes zero. */
export function evaluateRpgMakerFormula(
  formula: RpgMakerFormulaNode,
  context: RpgMakerFormulaContext,
): number {
  const value = evaluate(formula, context);
  return Number.isFinite(value) ? value : 0;
}

