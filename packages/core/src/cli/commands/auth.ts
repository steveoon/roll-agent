import { defineCommand } from "citty";

const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
export default defineCommand({
  meta: { description: "管理模型账号授权" },
  subCommands: {
    chatgpt: () =>
      import(new URL(`./auth-chatgpt.${extension}`, import.meta.url).href).then(
        (module) => module.default,
      ),
  },
});
