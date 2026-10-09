import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const config = [
  ...nextVitals,
  ...nextTs,
  { ignores: [".next/**", "node_modules/**", "playwright-report/**", "test-results/**", "next-env.d.ts"] },
  {
    rules: {
      // Raw HTML injection is banned outside the audited JSON-LD component.
      "react/no-danger": "error",
      "no-restricted-syntax": [
        "error",
        { selector: "CallExpression[callee.name='eval']", message: "eval is forbidden" },
        { selector: "NewExpression[callee.name='Function']", message: "new Function is forbidden" },
      ],
    },
  },
];

export default config;
