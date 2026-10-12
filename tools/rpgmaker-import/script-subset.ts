// tools/rpgmaker-import/script-subset.ts — import-time-only recognition of a
// deliberately small RPG Maker Script command/condition subset.
//
// RPG Maker stores these fields as JavaScript source.  This module never
// executes that source: it tokenizes it into a bounded JSON-like AST and then
// accepts only exact call/condition shapes.  Anything else is returned as a
// classified rejection for the coverage report.

import type {
  RpgMakerFormulaNode,
  RpgMakerMathFunction,
} from "../../src/rpgmaker-battle/formula.ts";

const MAX_SOURCE_LENGTH = 2_048;
const MAX_TOKENS = 512;
const MAX_AST_NODES = 512;
const MAX_DEPTH = 64;
const MAX_STATEMENTS = 32;
const MAX_RM_ID = 9_999;
const MAX_STRING_LENGTH = 4_096;

type TokenKind = "number" | "string" | "ident" | "symbol" | "eof";

interface Token {
  kind: TokenKind;
  text: string;
  value?: number | string;
  offset: number;
}

type Expression =
  | { kind: "number"; value: number }
  | { kind: "string"; value: string }
  | { kind: "boolean"; value: boolean }
  | { kind: "null" }
  | { kind: "identifier"; name: string }
  | { kind: "array"; values: Expression[] }
  | { kind: "object"; entries: { key: string; value: Expression }[] }
  | { kind: "group"; value: Expression }
  | { kind: "member"; object: Expression; property: string | Expression; computed: boolean }
  | { kind: "call"; callee: Expression; args: Expression[] }
  | { kind: "unary"; op: "+" | "-" | "!"; value: Expression }
  | {
      kind: "binary";
      op: "+" | "-" | "*" | "/" | "%" | "**" | "<" | "<=" | ">" | ">=" |
        "==" | "!=" | "===" | "!==" | "&&" | "||";
      left: Expression;
      right: Expression;
    }
  | { kind: "ternary"; test: Expression; yes: Expression; no: Expression };

export type ScriptItemKind = "item" | "weapon" | "armor";

export interface ScriptAudioValue {
  name: string;
  volume?: number;
  pitch?: number;
  pan?: number;
}

export type SafeScriptAction =
  | { kind: "setVariable"; id: number; value: RpgMakerFormulaNode; shape: string }
  | { kind: "setSwitch"; id: number; value: boolean; shape: string }
  | {
      kind: "setSelfSwitch";
      mapId: number;
      eventId: number;
      key: "A" | "B" | "C" | "D";
      value: boolean;
      shape: string;
    }
  | {
      kind: "changeItem";
      operation: "gain" | "lose";
      itemKind: ScriptItemKind;
      id: number;
      count: RpgMakerFormulaNode;
      includeEquipment: boolean;
      shape: string;
    }
  | {
      kind: "changeGold";
      operation: "gain" | "lose";
      amount: RpgMakerFormulaNode;
      shape: string;
    }
  | { kind: "locatePlayer"; x: RpgMakerFormulaNode; y: RpgMakerFormulaNode; shape: string }
  | {
      kind: "reserveTransfer";
      mapId: RpgMakerFormulaNode;
      x: RpgMakerFormulaNode;
      y: RpgMakerFormulaNode;
      direction?: number;
      fadeType?: number;
      shape: string;
    }
  | {
      kind: "setEventPosition";
      eventId: number;
      x: RpgMakerFormulaNode;
      y: RpgMakerFormulaNode;
      shape: string;
    }
  | { kind: "setEventDirection"; eventId: number; direction: number; shape: string }
  | { kind: "playAudio"; audioKind: "se" | "bgm"; audio: ScriptAudioValue; shape: string }
  | { kind: "addMessage"; text: string; shape: string };

export type ScriptCompareOp = "<" | "<=" | ">" | ">=" | "==" | "!=" | "===" | "!==";

export type SafeScriptCondition =
  | { kind: "variable"; id: number; op: ScriptCompareOp; value: number; shape: string }
  | { kind: "switch"; id: number; value: boolean; negate: boolean; shape: string }
  | {
      kind: "item";
      itemKind: ScriptItemKind;
      id: number;
      includeEquipment: boolean;
      negate: boolean;
      shape: string;
    }
  | { kind: "playerCoordinate"; axis: "x" | "y"; op: ScriptCompareOp; value: number; shape: string }
  | { kind: "playerDirection"; op: ScriptCompareOp; value: number; shape: string }
  | { kind: "steps"; op: ScriptCompareOp; value: number; shape: string };

export interface ScriptRejection {
  ok: false;
  /** Stable, source-free grouping key used by coverage reports. */
  shape: string;
  /** Stable explanation; never contains project source text. */
  reason: string;
}

export interface ScriptActionAcceptance {
  ok: true;
  actions: SafeScriptAction[];
}

export interface ScriptConditionAcceptance {
  ok: true;
  condition: SafeScriptCondition;
}

export type ScriptActionResult = ScriptActionAcceptance | ScriptRejection;
export type ScriptConditionResult = ScriptConditionAcceptance | ScriptRejection;

export class SafeScriptSyntaxError extends Error {
  constructor(readonly offset: number, readonly category: string) {
    super(`script ${category} at ${offset}`);
    this.name = "SafeScriptSyntaxError";
  }
}

const THREE_CHAR = new Set(["===", "!=="]);
const TWO_CHAR = new Set(["<=", ">=", "==", "!=", "&&", "||", "**"]);
const ONE_CHAR = new Set(["+", "-", "*", "/", "%", "<", ">", "!", "?", ":", ".", ",", ";", "(", ")", "[", "]", "{", "}", "="]);

function decodeEscape(source: string, at: number): { value: string; next: number } {
  const c = source[at];
  if (c === undefined) throw new SafeScriptSyntaxError(at, "unterminated string escape");
  const simple: Readonly<Record<string, string>> = {
    "\\": "\\", "'": "'", '"': '"', n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", "0": "\0",
  };
  if (simple[c] !== undefined) return { value: simple[c], next: at + 1 };
  if (c === "x") {
    const raw = source.slice(at + 1, at + 3);
    if (!/^[0-9a-f]{2}$/i.test(raw)) throw new SafeScriptSyntaxError(at, "invalid hex escape");
    return { value: String.fromCharCode(Number.parseInt(raw, 16)), next: at + 3 };
  }
  if (c === "u") {
    const raw = source.slice(at + 1, at + 5);
    if (!/^[0-9a-f]{4}$/i.test(raw)) throw new SafeScriptSyntaxError(at, "invalid unicode escape");
    return { value: String.fromCharCode(Number.parseInt(raw, 16)), next: at + 5 };
  }
  if (c === "\n") return { value: "", next: at + 1 };
  if (c === "\r" && source[at + 1] === "\n") return { value: "", next: at + 2 };
  throw new SafeScriptSyntaxError(at, "unsupported string escape");
}

function tokenize(source: string): Token[] {
  if (source.length > MAX_SOURCE_LENGTH) {
    throw new SafeScriptSyntaxError(MAX_SOURCE_LENGTH, `exceeds ${MAX_SOURCE_LENGTH} characters`);
  }
  const out: Token[] = [];
  const add = (token: Token): void => {
    out.push(token);
    if (out.length > MAX_TOKENS) {
      throw new SafeScriptSyntaxError(token.offset, `exceeds ${MAX_TOKENS} tokens`);
    }
  };
  let i = 0;
  while (i < source.length) {
    const c = source[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "/" && source[i + 1] === "/") {
      i += 2;
      while (i < source.length && source[i] !== "\n" && source[i] !== "\r") i++;
      continue;
    }
    if (c === "/" && source[i + 1] === "*") {
      const start = i;
      i += 2;
      while (i + 1 < source.length && !(source[i] === "*" && source[i + 1] === "/")) i++;
      if (i + 1 >= source.length) throw new SafeScriptSyntaxError(start, "unterminated block comment");
      i += 2;
      continue;
    }
    if (c === "'" || c === '"') {
      const quote = c;
      const start = i++;
      let value = "";
      let closed = false;
      while (i < source.length) {
        const here = source[i]!;
        if (here === quote) {
          i++;
          closed = true;
          break;
        }
        if (here === "\n" || here === "\r") throw new SafeScriptSyntaxError(i, "newline in string literal");
        if (here === "\\") {
          const decoded = decodeEscape(source, i + 1);
          value += decoded.value;
          i = decoded.next;
        } else {
          value += here;
          i++;
        }
        if (value.length > MAX_STRING_LENGTH) {
          throw new SafeScriptSyntaxError(start, `string exceeds ${MAX_STRING_LENGTH} characters`);
        }
      }
      if (!closed) throw new SafeScriptSyntaxError(start, "unterminated string literal");
      add({ kind: "string", text: source.slice(start, i), value, offset: start });
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
        if (digits === i) throw new SafeScriptSyntaxError(exponent, "malformed exponent");
      }
      const text = source.slice(start, i);
      const value = Number(text);
      if (!Number.isFinite(value)) throw new SafeScriptSyntaxError(start, "non-finite number");
      add({ kind: "number", text, value, offset: start });
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
      add({ kind: "symbol", text: three, offset: i });
      i += 3;
      continue;
    }
    const two = source.slice(i, i + 2);
    if (TWO_CHAR.has(two)) {
      add({ kind: "symbol", text: two, offset: i });
      i += 2;
      continue;
    }
    if (ONE_CHAR.has(c)) {
      add({ kind: "symbol", text: c, offset: i++ });
      continue;
    }
    throw new SafeScriptSyntaxError(i, "unsupported token");
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
  private depth = 0;

  constructor(private readonly tokens: readonly Token[]) {}

  program(): Expression[] {
    const out: Expression[] = [];
    while (this.peek().kind !== "eof") {
      if (this.peek().text === ";") throw new SafeScriptSyntaxError(this.peek().offset, "empty statement");
      out.push(this.expression());
      if (out.length > MAX_STATEMENTS) {
        throw new SafeScriptSyntaxError(this.peek().offset, `exceeds ${MAX_STATEMENTS} statements`);
      }
      if (this.peek().text === ";") {
        this.take(";");
        while (this.peek().text === ";") this.take(";");
      } else if (this.peek().kind !== "eof") {
        throw new SafeScriptSyntaxError(this.peek().offset, "statement separator required");
      }
    }
    if (out.length === 0) throw new SafeScriptSyntaxError(0, "empty source");
    validateAst(out, this.peek().offset);
    return out;
  }

  private nested<T>(fn: () => T): T {
    if (++this.depth > MAX_DEPTH) {
      throw new SafeScriptSyntaxError(this.peek().offset, `exceeds AST depth ${MAX_DEPTH}`);
    }
    try {
      return fn();
    } finally {
      this.depth--;
    }
  }

  private peek(): Token {
    return this.tokens[this.at]!;
  }

  private take(text?: string): Token {
    const token = this.peek();
    if (text !== undefined && token.text !== text) {
      throw new SafeScriptSyntaxError(token.offset, "unexpected token");
    }
    this.at++;
    return token;
  }

  private expression(): Expression {
    return this.nested(() => this.ternary());
  }

  private ternary(): Expression {
    const test = this.binary(1);
    if (this.peek().text !== "?") return test;
    this.take("?");
    const yes = this.expression();
    this.take(":");
    const no = this.expression();
    return { kind: "ternary", test, yes, no };
  }

  private binary(minPrecedence: number): Expression {
    let left = this.unary();
    for (;;) {
      const token = this.peek();
      const precedence = BINARY_PRECEDENCE[token.text];
      if (precedence === undefined || precedence < minPrecedence) return left;
      this.take();
      const right = this.nested(() => this.binary(token.text === "**" ? precedence : precedence + 1));
      left = {
        kind: "binary",
        op: token.text as Extract<Expression, { kind: "binary" }>["op"],
        left,
        right,
      };
    }
  }

  private unary(): Expression {
    const token = this.peek();
    if (token.text === "+" || token.text === "-" || token.text === "!") {
      this.take();
      return { kind: "unary", op: token.text, value: this.nested(() => this.unary()) };
    }
    return this.postfix();
  }

  private postfix(): Expression {
    let value = this.primary();
    for (;;) {
      if (this.peek().text === ".") {
        this.take(".");
        const property = this.take();
        if (property.kind !== "ident") throw new SafeScriptSyntaxError(property.offset, "member name required");
        value = { kind: "member", object: value, property: property.text, computed: false };
      } else if (this.peek().text === "[") {
        this.take("[");
        const property = this.expression();
        this.take("]");
        value = { kind: "member", object: value, property, computed: true };
      } else if (this.peek().text === "(") {
        this.take("(");
        const args: Expression[] = [];
        if (this.peek().text !== ")") {
          for (;;) {
            args.push(this.expression());
            if (args.length > 32) throw new SafeScriptSyntaxError(this.peek().offset, "too many call arguments");
            if (this.peek().text !== ",") break;
            this.take(",");
          }
        }
        this.take(")");
        value = { kind: "call", callee: value, args };
      } else {
        return value;
      }
    }
  }

  private primary(): Expression {
    const token = this.take();
    if (token.kind === "number") return { kind: "number", value: token.value as number };
    if (token.kind === "string") return { kind: "string", value: token.value as string };
    if (token.kind === "ident") {
      if (token.text === "true" || token.text === "false") return { kind: "boolean", value: token.text === "true" };
      if (token.text === "null") return { kind: "null" };
      return { kind: "identifier", name: token.text };
    }
    if (token.text === "(") {
      const value = this.expression();
      this.take(")");
      return { kind: "group", value };
    }
    if (token.text === "[") {
      const values: Expression[] = [];
      if (this.peek().text !== "]") {
        for (;;) {
          values.push(this.expression());
          if (values.length > 32) throw new SafeScriptSyntaxError(this.peek().offset, "array is too long");
          if (this.peek().text !== ",") break;
          this.take(",");
        }
      }
      this.take("]");
      return { kind: "array", values };
    }
    if (token.text === "{") {
      const entries: { key: string; value: Expression }[] = [];
      if (this.peek().text !== "}") {
        for (;;) {
          const key = this.take();
          if (key.kind !== "ident" && key.kind !== "string") {
            throw new SafeScriptSyntaxError(key.offset, "object key required");
          }
          this.take(":");
          entries.push({ key: key.kind === "string" ? key.value as string : key.text, value: this.expression() });
          if (entries.length > 16) throw new SafeScriptSyntaxError(this.peek().offset, "object is too large");
          if (this.peek().text !== ",") break;
          this.take(",");
        }
      }
      this.take("}");
      return { kind: "object", entries };
    }
    throw new SafeScriptSyntaxError(token.offset, "expression required");
  }
}

function validateAst(roots: readonly Expression[], sourceLength: number): void {
  let nodes = MAX_AST_NODES;
  const visit = (node: Expression, depth: number): void => {
    if (depth > MAX_DEPTH) throw new SafeScriptSyntaxError(sourceLength, `exceeds AST depth ${MAX_DEPTH}`);
    if (--nodes < 0) throw new SafeScriptSyntaxError(sourceLength, `exceeds ${MAX_AST_NODES} AST nodes`);
    switch (node.kind) {
      case "number":
      case "string":
      case "boolean":
      case "null":
      case "identifier":
        return;
      case "array":
        for (const value of node.values) visit(value, depth + 1);
        return;
      case "object":
        for (const entry of node.entries) visit(entry.value, depth + 1);
        return;
      case "group":
      case "unary":
        visit(node.value, depth + 1);
        return;
      case "member":
        visit(node.object, depth + 1);
        if (node.computed) visit(node.property as Expression, depth + 1);
        return;
      case "call":
        visit(node.callee, depth + 1);
        for (const argument of node.args) visit(argument, depth + 1);
        return;
      case "binary":
        visit(node.left, depth + 1);
        visit(node.right, depth + 1);
        return;
      case "ternary":
        visit(node.test, depth + 1);
        visit(node.yes, depth + 1);
        visit(node.no, depth + 1);
        return;
    }
  };
  for (const root of roots) visit(root, 0);
}

function parse(source: string): Expression[] {
  return new Parser(tokenize(source)).program();
}

function ident(node: Expression, name: string): boolean {
  return node.kind === "identifier" && node.name === name;
}

function member(node: Expression, root: string, property: string): boolean {
  return node.kind === "member" && !node.computed && node.property === property && ident(node.object, root);
}

function directCall(node: Expression, root: string, method: string): Expression[] | null {
  return node.kind === "call" && member(node.callee, root, method) ? node.args : null;
}

function literalNumber(node: Expression): number | null {
  if (node.kind === "number") return node.value;
  if (node.kind === "group") return literalNumber(node.value);
  if (node.kind === "unary" && (node.op === "+" || node.op === "-")) {
    const value = literalNumber(node.value);
    if (value !== null) return node.op === "-" ? -value : value;
  }
  return null;
}

function literalInteger(node: Expression): number | null {
  const value = literalNumber(node);
  return value !== null && Number.isSafeInteger(value) ? value : null;
}

function rmId(node: Expression): number | null {
  const value = literalInteger(node);
  return value !== null && value >= 1 && value <= MAX_RM_ID ? value : null;
}

function literalBoolean(node: Expression): boolean | null {
  return node.kind === "boolean" ? node.value : node.kind === "group" ? literalBoolean(node.value) : null;
}

function literalString(node: Expression): string | null {
  return node.kind === "string" ? node.value : node.kind === "group" ? literalString(node.value) : null;
}

function variableValueCall(node: Expression): number | null {
  const args = directCall(node, "$gameVariables", "value");
  return args?.length === 1 ? rmId(args[0]!) : null;
}

const MATH_FUNCTIONS = new Set<RpgMakerMathFunction>([
  "abs", "ceil", "floor", "round", "trunc", "sign", "sqrt", "cbrt",
  "min", "max", "pow", "hypot", "sin", "cos", "tan", "asin", "acos", "atan", "atan2",
]);

/** Project a parsed expression onto the same safe formula AST K-RPGM3 uses
 * for damage formulas. Script expressions deliberately omit battler a/b
 * reads, and map `$gameVariables.value(n)` to the existing variable node. */
function formula(node: Expression): RpgMakerFormulaNode | null {
  switch (node.kind) {
    case "number":
      return { kind: "number", value: node.value };
    case "group": {
      const value = formula(node.value);
      return value ? { kind: "group", value } : null;
    }
    case "unary": {
      if (node.op !== "+" && node.op !== "-") return null;
      const value = formula(node.value);
      return value ? { kind: "unary", op: node.op, value } : null;
    }
    case "binary": {
      if (!["+", "-", "*", "/", "%", "**"].includes(node.op)) return null;
      const left = formula(node.left);
      const right = formula(node.right);
      return left && right ? {
        kind: "binary",
        op: node.op as Extract<RpgMakerFormulaNode, { kind: "binary" }>["op"],
        left,
        right,
      } : null;
    }
    case "member":
      if (!node.computed && ident(node.object, "Math") && (node.property === "PI" || node.property === "E")) {
        return { kind: "mathConst", name: node.property };
      }
      return null;
    case "call": {
      const variable = variableValueCall(node);
      if (variable !== null) return { kind: "variable", index: variable };
      if (node.callee.kind !== "member" || node.callee.computed || !ident(node.callee.object, "Math")) return null;
      const name = node.callee.property;
      if (typeof name !== "string" || !MATH_FUNCTIONS.has(name as RpgMakerMathFunction)) return null;
      const args = node.args.map(formula);
      if (args.some((argument) => argument === null)) return null;
      return { kind: "math", name: name as RpgMakerMathFunction, args: args as RpgMakerFormulaNode[] };
    }
    default:
      return null;
  }
}

function itemReference(node: Expression): { kind: ScriptItemKind; id: number } | null {
  if (node.kind !== "member" || !node.computed || node.object.kind !== "identifier") return null;
  const kinds: Readonly<Record<string, ScriptItemKind>> = {
    $dataItems: "item",
    $dataWeapons: "weapon",
    $dataArmors: "armor",
  };
  const kind = kinds[node.object.name];
  const id = typeof node.property === "string" ? null : rmId(node.property);
  return kind && id !== null ? { kind, id } : null;
}

function audioValue(node: Expression): ScriptAudioValue | null {
  if (node.kind !== "object") return null;
  const allowed = new Set(["name", "volume", "pitch", "pan"]);
  const values = new Map<string, Expression>();
  for (const entry of node.entries) {
    if (!allowed.has(entry.key) || values.has(entry.key)) return null;
    values.set(entry.key, entry.value);
  }
  const nameNode = values.get("name");
  const name = nameNode ? literalString(nameNode) : null;
  if (name === null || name.length > 255) return null;
  const out: ScriptAudioValue = { name };
  for (const key of ["volume", "pitch", "pan"] as const) {
    const raw = values.get(key);
    if (!raw) continue;
    const value = literalNumber(raw);
    if (value === null || !Number.isFinite(value)) return null;
    out[key] = value;
  }
  return out;
}

const reject = (shape: string, reason: string): ScriptRejection => ({ ok: false, shape, reason });

function action(node: Expression): SafeScriptAction | ScriptRejection {
  let args = directCall(node, "$gameVariables", "setValue");
  if (args) {
    const shape = "$gameVariables.setValue(id, expression)";
    const id = args.length === 2 ? rmId(args[0]!) : null;
    const value = args.length === 2 ? formula(args[1]!) : null;
    return id !== null && value ? { kind: "setVariable", id, value, shape } : reject(shape, "requires a bounded positive id and a safe numeric expression");
  }
  args = directCall(node, "$gameSwitches", "setValue");
  if (args) {
    const shape = "$gameSwitches.setValue(id, boolean)";
    const id = args.length === 2 ? rmId(args[0]!) : null;
    const value = args.length === 2 ? literalBoolean(args[1]!) : null;
    return id !== null && value !== null ? { kind: "setSwitch", id, value, shape } : reject(shape, "requires a bounded positive id and a boolean literal");
  }
  args = directCall(node, "$gameSelfSwitches", "setValue");
  if (args) {
    const shape = "$gameSelfSwitches.setValue([map,event,key], boolean)";
    const key = args[0];
    const value = args.length === 2 ? literalBoolean(args[1]!) : null;
    if (args.length !== 2 || key?.kind !== "array" || key.values.length !== 3 || value === null) {
      return reject(shape, "requires a literal map/event/key tuple and boolean value");
    }
    const mapId = rmId(key.values[0]!);
    const eventId = rmId(key.values[1]!);
    const letter = literalString(key.values[2]!);
    if (mapId === null || eventId === null || (letter !== "A" && letter !== "B" && letter !== "C" && letter !== "D")) {
      return reject(shape, "requires bounded positive map/event ids and self-switch A-D");
    }
    return { kind: "setSelfSwitch", mapId, eventId, key: letter, value, shape };
  }
  for (const [method, operation] of [["gainItem", "gain"], ["loseItem", "lose"]] as const) {
    args = directCall(node, "$gameParty", method);
    if (!args) continue;
    const shape = `$gameParty.${method}(dataItem, expression)`;
    const item = args.length >= 2 && args.length <= 3 ? itemReference(args[0]!) : null;
    const count = args.length >= 2 && args.length <= 3 ? formula(args[1]!) : null;
    const include = args.length === 3 ? literalBoolean(args[2]!) : false;
    return item && count && include !== null
      ? { kind: "changeItem", operation, itemKind: item.kind, id: item.id, count, includeEquipment: include, shape }
      : reject(shape, "requires a database item, safe numeric count, and optional boolean include-equipment flag");
  }
  for (const [method, operation] of [["gainGold", "gain"], ["loseGold", "lose"]] as const) {
    args = directCall(node, "$gameParty", method);
    if (!args) continue;
    const shape = `$gameParty.${method}(expression)`;
    const amount = args.length === 1 ? formula(args[0]!) : null;
    return amount ? { kind: "changeGold", operation, amount, shape } : reject(shape, "requires one safe numeric expression");
  }
  args = directCall(node, "$gamePlayer", "locate");
  if (args) {
    const shape = "$gamePlayer.locate(x, y)";
    const x = args.length === 2 ? formula(args[0]!) : null;
    const y = args.length === 2 ? formula(args[1]!) : null;
    return x && y ? { kind: "locatePlayer", x, y, shape } : reject(shape, "requires two safe numeric expressions");
  }
  args = directCall(node, "$gamePlayer", "reserveTransfer");
  if (args) {
    const shape = "$gamePlayer.reserveTransfer(map, x, y, direction, fade)";
    const mapId = args.length >= 3 && args.length <= 5 ? formula(args[0]!) : null;
    const x = args.length >= 3 && args.length <= 5 ? formula(args[1]!) : null;
    const y = args.length >= 3 && args.length <= 5 ? formula(args[2]!) : null;
    const direction = args[3] === undefined ? undefined : literalInteger(args[3]);
    const fadeType = args[4] === undefined ? undefined : literalInteger(args[4]);
    return mapId && x && y && direction !== null && fadeType !== null
      ? { kind: "reserveTransfer", mapId, x, y, ...(direction !== undefined ? { direction } : {}), ...(fadeType !== undefined ? { fadeType } : {}), shape }
      : reject(shape, "requires safe map/x/y expressions and optional integer direction/fade literals");
  }
  if (node.kind === "call" && node.callee.kind === "member" && !node.callee.computed && node.callee.object.kind === "call") {
    const target = node.callee.object;
    const eventArgs = directCall(target, "$gameMap", "event");
    const event = eventArgs?.length === 1 ? rmId(eventArgs[0]!) : null;
    if (eventArgs && node.callee.property === "setPosition") {
      const shape = "$gameMap.event(id).setPosition(x, y)";
      const x = node.args.length === 2 ? formula(node.args[0]!) : null;
      const y = node.args.length === 2 ? formula(node.args[1]!) : null;
      return event !== null && x && y ? { kind: "setEventPosition", eventId: event, x, y, shape } : reject(shape, "requires a bounded event id and safe coordinate expressions");
    }
    if (eventArgs && node.callee.property === "setDirection") {
      const shape = "$gameMap.event(id).setDirection(direction)";
      const direction = node.args.length === 1 ? literalInteger(node.args[0]!) : null;
      return event !== null && direction !== null ? { kind: "setEventDirection", eventId: event, direction, shape } : reject(shape, "requires bounded event and integer direction literals");
    }
  }
  for (const [method, audioKind] of [["playSe", "se"], ["playBgm", "bgm"]] as const) {
    args = directCall(node, "AudioManager", method);
    if (!args) continue;
    const shape = `AudioManager.${method}({name,volume,pitch,pan})`;
    const audio = args.length === 1 ? audioValue(args[0]!) : null;
    return audio ? { kind: "playAudio", audioKind, audio, shape } : reject(shape, "requires one bounded audio object with only name/volume/pitch/pan literals");
  }
  args = directCall(node, "$gameMessage", "add");
  if (args) {
    const shape = "$gameMessage.add(string)";
    const text = args.length === 1 ? literalString(args[0]!) : null;
    return text !== null ? { kind: "addMessage", text, shape } : reject(shape, "requires one string literal");
  }
  return reject("unsupported action shape", "call or expression is outside the safe Script action subset");
}

function comparison(node: Expression): { left: Expression; op: ScriptCompareOp; right: Expression } | null {
  return node.kind === "binary" && ["<", "<=", ">", ">=", "==", "!=", "===", "!=="].includes(node.op)
    ? { left: node.left, op: node.op as ScriptCompareOp, right: node.right }
    : node.kind === "group" ? comparison(node.value) : null;
}

function reverseComparison(op: ScriptCompareOp): ScriptCompareOp {
  switch (op) {
    case "<": return ">";
    case "<=": return ">=";
    case ">": return "<";
    case ">=": return "<=";
    default: return op;
  }
}

function comparedReader(
  node: Expression,
): { reader: Expression; op: ScriptCompareOp; value: number } | null {
  const c = comparison(node);
  if (!c) return null;
  const right = literalNumber(c.right);
  if (right !== null) return { reader: c.left, op: c.op, value: right };
  const left = literalNumber(c.left);
  return left !== null ? { reader: c.right, op: reverseComparison(c.op), value: left } : null;
}

function condition(node: Expression): SafeScriptCondition | ScriptRejection {
  const compared = comparedReader(node);
  if (compared) {
    const variable = variableValueCall(compared.reader);
    if (variable !== null) {
      const shape = "$gameVariables.value(id) comparison number";
      return { kind: "variable", id: variable, op: compared.op, value: compared.value, shape };
    }
    if (compared.reader.kind === "member" && !compared.reader.computed && ident(compared.reader.object, "$gamePlayer") &&
        (compared.reader.property === "x" || compared.reader.property === "y")) {
      const shape = `$gamePlayer.${compared.reader.property} comparison number`;
      return { kind: "playerCoordinate", axis: compared.reader.property, op: compared.op, value: compared.value, shape };
    }
    const directionArgs = directCall(compared.reader, "$gamePlayer", "direction");
    if (directionArgs?.length === 0) {
      const shape = "$gamePlayer.direction() comparison number";
      return { kind: "playerDirection", op: compared.op, value: compared.value, shape };
    }
    const stepArgs = directCall(compared.reader, "$gameParty", "steps");
    if (stepArgs?.length === 0) {
      const shape = "$gameParty.steps() comparison number";
      return { kind: "steps", op: compared.op, value: compared.value, shape };
    }
  }
  const negated = node.kind === "unary" && node.op === "!";
  const call = negated ? node.value : node;
  let args = directCall(call, "$gameParty", "hasItem");
  if (args) {
    const shape = "$gameParty.hasItem(dataItem, includeEquipment?)";
    const item = args.length >= 1 && args.length <= 2 ? itemReference(args[0]!) : null;
    const include = args.length === 2 ? literalBoolean(args[1]!) : false;
    return item && include !== null
      ? { kind: "item", itemKind: item.kind, id: item.id, includeEquipment: include, negate: negated, shape }
      : reject(shape, "requires a database item and optional boolean include-equipment literal");
  }
  args = directCall(call, "$gameSwitches", "value");
  if (args) {
    const shape = "$gameSwitches.value(id)";
    const id = args.length === 1 ? rmId(args[0]!) : null;
    return id !== null ? { kind: "switch", id, value: true, negate: negated, shape } : reject(shape, "requires a bounded positive switch id");
  }
  return reject("unsupported condition shape", "expression is outside the safe Script condition subset");
}

function syntaxRejection(error: unknown): ScriptRejection {
  if (error instanceof SafeScriptSyntaxError) return reject("syntax rejected", error.category);
  return reject("syntax rejected", "parser rejected the source");
}

/** Parse and classify a 355/655 Script command. Every statement must be an
 * accepted action; one unsupported statement rejects the whole source so an
 * attacker cannot hide a side effect beside an otherwise valid call. */
export function recognizeScriptActions(source: string): ScriptActionResult {
  try {
    const nodes = parse(source);
    const actions: SafeScriptAction[] = [];
    for (const node of nodes) {
      const parsed = action(node);
      if ("ok" in parsed) return parsed;
      actions.push(parsed);
    }
    return { ok: true, actions };
  } catch (error) {
    return syntaxRejection(error);
  }
}

/** Parse and classify Conditional Branch → Script. Conditions must contain
 * exactly one expression; statement sequences always fail closed. */
export function recognizeScriptCondition(source: string): ScriptConditionResult {
  try {
    const nodes = parse(source);
    if (nodes.length !== 1) return reject("condition statement sequence", "a Script condition must contain exactly one expression");
    const parsed = condition(nodes[0]!);
    return "ok" in parsed ? parsed : { ok: true, condition: parsed };
  } catch (error) {
    return syntaxRejection(error);
  }
}

