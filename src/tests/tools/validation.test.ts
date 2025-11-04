import { describe, expect, test } from "bun:test";
import {
  validateParamTypes,
  validateRequiredParams,
} from "../../tools/impl/validation";

describe("validateRequiredParams", () => {
  test("passes when all required params are present", () => {
    expect(() => {
      validateRequiredParams(
        { path: "/test", name: "file" },
        ["path", "name"],
        "TestTool",
      );
    }).not.toThrow();
  });

  test("throws when required param is missing", () => {
    expect(() => {
      validateRequiredParams({ name: "file" }, ["path", "name"], "TestTool");
    }).toThrow(/missing required parameter.*path/);
  });

  test("throws with multiple missing params", () => {
    expect(() => {
      validateRequiredParams({}, ["path", "name"], "TestTool");
    }).toThrow(/missing required parameters.*path.*name/);
  });
});

describe("validateParamTypes", () => {
  test("passes when string param has correct type", () => {
    const schema = {
      type: "object",
      properties: {
        path: { type: "string" },
      },
    };

    expect(() => {
      validateParamTypes({ path: "/test" }, schema, "TestTool");
    }).not.toThrow();
  });

  test("passes when array param has correct type", () => {
    const schema = {
      type: "object",
      properties: {
        ignore: {
          type: "array",
          items: { type: "string" },
        },
      },
    };

    expect(() => {
      validateParamTypes({ ignore: ["*.log"] }, schema, "TestTool");
    }).not.toThrow();
  });

  test("throws when array param is given as string", () => {
    const schema = {
      type: "object",
      properties: {
        ignore: {
          type: "array",
          items: { type: "string" },
        },
      },
    };

    expect(() => {
      validateParamTypes({ ignore: '["*.log"]' }, schema, "TestTool");
    }).toThrow(/must be an array.*received string/);
  });

  test("throws when string param is given as number", () => {
    const schema = {
      type: "object",
      properties: {
        path: { type: "string" },
      },
    };

    expect(() => {
      validateParamTypes({ path: 123 }, schema, "TestTool");
    }).toThrow(/must be a string.*received integer/);
  });

  test("throws when object param is given as string", () => {
    const schema = {
      type: "object",
      properties: {
        config: { type: "object" },
      },
    };

    expect(() => {
      validateParamTypes({ config: '{"key": "value"}' }, schema, "TestTool");
    }).toThrow(/must be an object.*received string/);
  });

  test("throws when boolean param is given as string", () => {
    const schema = {
      type: "object",
      properties: {
        enabled: { type: "boolean" },
      },
    };

    expect(() => {
      validateParamTypes({ enabled: "true" }, schema, "TestTool");
    }).toThrow(/must be a boolean.*received string/);
  });

  test("allows optional params to be undefined", () => {
    const schema = {
      type: "object",
      properties: {
        path: { type: "string" },
        ignore: { type: "array" },
      },
      required: ["path"],
    };

    expect(() => {
      validateParamTypes({ path: "/test" }, schema, "TestTool");
    }).not.toThrow();
  });

  test("throws with clear error message indicating expected vs received type", () => {
    const schema = {
      type: "object",
      properties: {
        ignore: {
          type: "array",
          items: { type: "string" },
        },
      },
    };

    expect(() => {
      validateParamTypes({ ignore: "not-an-array" }, schema, "TestTool");
    }).toThrow(
      /TestTool: Parameter 'ignore' must be an array, received string/,
    );
  });

  test("validates array item types", () => {
    const schema = {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: { type: "string" },
        },
      },
    };

    expect(() => {
      validateParamTypes(
        { items: ["valid", 123, "string"] },
        schema,
        "TestTool",
      );
    }).toThrow(/items\[1\].*must be a string.*received integer/);
  });

  test("passes when array items have correct types", () => {
    const schema = {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: { type: "string" },
        },
      },
    };

    expect(() => {
      validateParamTypes(
        { items: ["all", "strings", "here"] },
        schema,
        "TestTool",
      );
    }).not.toThrow();
  });
});
