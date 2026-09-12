import { z } from "zod";

import { OpenAiResponsesInputError } from "./errors.ts";

type Schema = Readonly<Record<string, unknown>>;
type Codec = {
  readonly schema: Schema;
  encode(value: unknown): unknown;
  decode(value: unknown): unknown;
};

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Translate the wire representation only. Native validators still own admission. */
export function responsesToolSchema(native: Schema): Codec {
  const inner = node(native);
  if (native.type === "object" && native.anyOf === undefined && native.oneOf === undefined) {
    return inner;
  }
  return {
    schema: {
      type: "object",
      properties: { input: inner.schema },
      required: ["input"],
      additionalProperties: false,
    },
    encode: (value) => ({ input: inner.encode(value) }),
    decode(value) {
      if (!object(value) || Object.keys(value).length !== 1 || !("input" in value)) {
        throw new OpenAiResponsesInputError(
          "invalid-request",
          "Tool arguments require an input envelope.",
        );
      }
      return inner.decode(value.input);
    },
  };
}

function node(native: Schema): Codec {
  const { $schema: _dialect, default: _default, ...base } = native;
  const variants = native.anyOf ?? native.oneOf;
  if (Array.isArray(variants)) {
    const branches = variants.map((value: Schema) => {
      const codec = node(value);
      return { codec, accepts: z.fromJSONSchema(value), wire: z.fromJSONSchema(codec.schema) };
    });
    const convert = (value: unknown, direction: "encode" | "decode"): unknown => {
      const candidates = branches.flatMap(({ codec, accepts, wire }) => {
        if (direction === "decode" && !wire.safeParse(value).success) return [];
        const decoded = direction === "decode" ? codec.decode(value) : value;
        return accepts.safeParse(decoded).success
          ? [direction === "encode" ? codec.encode(value) : decoded]
          : [];
      });
      if (candidates.length === 0) return value; // The native validator reports malformed input.
      if (new Set(candidates.map((candidate) => JSON.stringify(candidate))).size > 1) {
        throw new OpenAiResponsesInputError(
          "invalid-request",
          "Tool arguments have ambiguous union representations.",
        );
      }
      return candidates[0];
    };
    const { oneOf: _oneOf, anyOf: _anyOf, ...rest } = base;
    return {
      schema: { ...rest, anyOf: branches.map(({ codec }) => codec.schema) },
      encode: (value) => convert(value, "encode"),
      decode: (value) => convert(value, "decode"),
    };
  }
  if (native.type === "object") {
    const required = new Set(Array.isArray(native.required) ? native.required : []);
    const children = Object.entries(object(native.properties) ? native.properties : {}).map(
      ([key, value]) => {
        if (!object(value))
          throw new OpenAiResponsesInputError(
            "unsupported-capability",
            "Unsupported tool property schema.",
          );
        return {
          key,
          codec: node(value),
          optional: !required.has(key),
          nullable: z.fromJSONSchema(value).safeParse(null).success,
        };
      },
    );
    const convert = (value: unknown, direction: "encode" | "decode"): unknown => {
      if (!object(value)) return value;
      const result = { ...value };
      for (const { key, codec, optional, nullable } of children) {
        if (optional && direction === "encode") {
          result[key] = !(key in value)
            ? null
            : nullable
              ? { value: codec.encode(value[key]) }
              : codec.encode(value[key]);
        } else if (optional && direction === "decode" && value[key] === null) {
          delete result[key];
        } else if (optional && nullable && direction === "decode" && key in value) {
          const wrapped = value[key];
          if (!object(wrapped) || Object.keys(wrapped).length !== 1 || !("value" in wrapped)) {
            throw new OpenAiResponsesInputError(
              "invalid-request",
              "Nullable optional arguments require a value envelope.",
            );
          }
          result[key] = codec.decode(wrapped.value);
        } else if (key in value) result[key] = codec[direction](value[key]);
      }
      return result;
    };
    return {
      schema: {
        ...base,
        properties: Object.fromEntries(
          children.map(({ key, codec, optional, nullable }) => [
            key,
            optional
              ? {
                  anyOf: [
                    nullable
                      ? {
                          type: "object",
                          properties: { value: codec.schema },
                          required: ["value"],
                          additionalProperties: false,
                        }
                      : codec.schema,
                    { type: "null" },
                  ],
                }
              : codec.schema,
          ]),
        ),
        required: children.map(({ key }) => key),
        additionalProperties: false,
      },
      encode: (value) => convert(value, "encode"),
      decode: (value) => convert(value, "decode"),
    };
  }
  if (native.type === "array" && object(native.items)) {
    const child = node(native.items);
    return {
      schema: { ...base, items: child.schema },
      encode: (value) => (Array.isArray(value) ? value.map(child.encode) : value),
      decode: (value) => (Array.isArray(value) ? value.map(child.decode) : value),
    };
  }
  return { schema: base, encode: (value) => value, decode: (value) => value };
}
