import {
  createLogger,
  format,
  transports,
  Logger as WinstonLogger,
} from "winston";
import dayjs from "dayjs";
import path from "path";

const loggerMaps = new Map();

const stackReg = /^(?:\s*)at (?:(.+) \()?(?:([^(]+?):(\d+):(\d+))\)?$/;

function parseError(err: Error, skip: number) {
  try {
    const stacklines = err.stack?.split("\n").slice(skip);
    if (!stacklines?.length) {
      return undefined;
    }

    const lineMatch = stackReg.exec(stacklines[0]);
    if (!lineMatch || lineMatch.length < 5) {
      return undefined;
    }

    let className = "";
    let functionName = "";
    let functionAlias = "";
    if (lineMatch[1] && lineMatch[1] !== "") {
      [functionName, functionAlias] = lineMatch[1]
        .replace(/[[\]]/g, "")
        .split(" as ");
      functionAlias = functionAlias || "";

      if (functionName.includes(".")) {
        [className, functionName] = functionName.split(".");
      }
    }

    return {
      className,
      functionName,
      functionAlias,
      callerName: lineMatch[1] || "",
      fileName: lineMatch[2],
      lineNumber: parseInt(lineMatch[3], 10),
      columnNumber: parseInt(lineMatch[4], 10),
    };
  } catch {
    return undefined;
  }
}

function lineNumber(backtraceLevel: number) {
  const stk = parseError(new Error(), backtraceLevel + 2);
  if (stk === undefined) {
    return "<unknown>";
  }
  return `${path.basename(stk.fileName)}:${stk.lineNumber}`;
}

interface LoggerOptions {
  level: string;
  filename?: string;
  logpath?: string;

  file?: boolean;
  console?: boolean;
}

type AttrObject = {
  [key: string]: AttrValue;
};
type AttrArray = AttrValue[];
type AttrValue = string | number | boolean | null | AttrObject | AttrArray;

export function jsonlize(
  obj: unknown,
  weakset: WeakSet<object>,
  maxDepth: number,
  depth: number
): AttrValue {
  if (depth > maxDepth) {
    return `exceeded`;
  }

  if (
    typeof obj === "string" ||
    typeof obj === "number" ||
    typeof obj === "boolean"
  ) {
    return obj;
  }

  if (typeof obj === "undefined") {
    return null;
  }

  if (typeof obj === "bigint") {
    return obj.toString();
  }

  if (typeof obj === "function" || typeof obj === "symbol") {
    return String(obj);
  }

  // obj must be object now
  if (obj === null) {
    return null;
  }

  if (typeof obj === "object" && obj !== null && weakset.has(obj)) {
    return "<circular>";
  }

  if (obj instanceof RegExp) {
    return `RegExp<${obj.toString()}>`;
  }

  if (obj instanceof Buffer) {
    return `Buffer<data:0x${obj.subarray(0, 16).toString("hex")}... length:${obj.length}>`;
  }

  if (ArrayBuffer.isView(obj)) {
    return `ArrayBuffer<${obj.constructor.name} byteLength:${obj.byteLength}>`;
  }

  if (obj instanceof Error) {
    return `Error<${obj.name} message:${obj.message} stack:${obj.stack}>`;
  }

  if (obj instanceof Date) {
    return obj.toISOString();
  }

  if (obj instanceof Promise) {
    return `Promise<pending>`;
  }

  if (obj instanceof Map) {
    const result: AttrObject = {};
    weakset.add(obj);
    for (const [key, value] of obj.entries()) {
      // Only string and number keys will be converted
      if (typeof key === "string" || typeof key === "number") {
        result[key] = jsonlize(value, weakset, maxDepth, depth + 1);
      }
    }
    weakset.delete(obj);
    return result;
  }

  if (obj instanceof Set) {
    const result: AttrArray = [];
    weakset.add(obj);
    for (const value of obj.values()) {
      result.push(jsonlize(value, weakset, maxDepth, depth + 1));
    }
    weakset.delete(obj);
    return result;
  }

  if (Array.isArray(obj)) {
    const result: AttrArray = [];
    weakset.add(obj);
    for (const element of obj) {
      result.push(jsonlize(element, weakset, maxDepth, depth + 1));
    }
    weakset.delete(obj);
    return result;
  }

  // plain object, builtin types subclass instances, custom class instances.
  weakset.add(obj);
  // obj might be {}
  const result: AttrObject = {};
  for (const key of Object.getOwnPropertyNames(obj)) {
    // console.log(`key: ${key} value: ${inspect(obj[key])}`);
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      result[key] = jsonlize(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (obj as any)[key], // tell typescript to stop false alarm
        weakset,
        maxDepth,
        depth + 1
      );
    }
  }
  weakset.delete(obj);
  return result;
}

export class Logger {
  _logger: WinstonLogger;

  constructor(options: LoggerOptions) {
    this._logger = createLogger({
      level: options.level,
      format: format.combine(
        format.errors({ stack: false }),
        format.simple(),
        format.colorize()
      ),
      transports: [],
    });

    if (options?.file) {
      const logpath = options.logpath;
      const filename = options.filename;

      if (logpath === undefined || filename === undefined) {
        throw new Error("logpath and filename must be set when file is true");
      }

      this._logger.add(
        new transports.File({
          filename: path.join(logpath, `${filename}.log`),
          level: "info",
        })
      );
      this._logger.add(
        new transports.File({
          filename: path.join(logpath, `${filename}_error.log`),
          level: "error",
        })
      );
      this._logger.add(
        new transports.File({
          filename: path.join(logpath, "debug.log"),
          level: "debug",
        })
      );
    }

    if (options?.console || options?.file === undefined) {
      this._logger.add(
        new transports.Console({
          level: options.level,
          format: format.combine(
            format.errors({ stack: false }),
            format.simple()
          ),
        })
      );
    }
  }

  #formatMessage(level: string, ...args: unknown[]) {
    const transArgs = args.map((obj) => {
      if (typeof obj === "object") {
        return jsonlize(obj, new WeakSet(), 10, 0);
      }
      return String(obj);
    });
    return `${dayjs().format("YYYY-MM-DD HH:mm:ss")} ${lineNumber(2)} [${level.toUpperCase()}] (${process.pid}) ${transArgs.join(" ")}`;
  }

  debug(...args: unknown[]) {
    this._logger.debug(this.#formatMessage("debug", ...args));
  }

  info(...args: unknown[]) {
    this._logger.info(this.#formatMessage("info", ...args));
  }

  warn(...args: unknown[]) {
    this._logger.warn(this.#formatMessage("warn", ...args));
  }

  error(...args: unknown[]) {
    this._logger.error(this.#formatMessage("error", ...args));
  }
}

export default function getOrCreateLogger(
  name: string,
  options?: LoggerOptions
): Logger {
  if (loggerMaps.has(name)) return loggerMaps.get(name);

  const l = new Logger(
    Object.assign(
      {
        filename: name,
        logpath: "./",
        level: "info",
      },
      options
    )
  );
  loggerMaps.set(name, l);
  return l;
}
