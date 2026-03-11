import { defineCommand } from "citty";

export default defineCommand({
  meta: { description: "管理全局配置" },
  args: {
    action: { type: "positional", description: "操作（set/get/init）", required: true },
    key: { type: "positional", description: "配置键", required: false },
    value: { type: "positional", description: "配置值", required: false },
  },
  run({ args }) {
    console.log(`TODO: config ${args.action} ${args.key ?? ""} ${args.value ?? ""}`);
  },
});
