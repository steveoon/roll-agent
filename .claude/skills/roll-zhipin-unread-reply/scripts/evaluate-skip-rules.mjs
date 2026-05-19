#!/usr/bin/env node
/**
 * Team skip rules for BOSS unread reply workflow.
 * stdin: JSON { preview, candidateInfo, preferredBrand, chatMessages, pageUrl, pageTitle }
 * stdout: JSON { skip: boolean, reason?: string }
 */
let input;
try {
  const raw = await new Promise((resolve) => {
    let s = "";
    process.stdin.on("data", (d) => {
      s += d;
    });
    process.stdin.on("end", () => resolve(s));
  });
  input = JSON.parse(raw);
} catch {
  console.log(JSON.stringify({ skip: false, reason: "invalid_skip_input" }));
  process.exit(1);
}

const { preview = "", candidateInfo = {}, preferredBrand = "", chatMessages = [], pageUrl = "", pageTitle = "" } = input;

const DECLINE = ["不考虑了", "不合适", "不感兴趣", "算了", "谢谢不用了"];
const STUDENT_KW = ["应届", "在校", "在读", "大三", "大四"];
const WECHAT_ADDED_KW = ["我加您了", "我加了", "加了您", "已经加了", "已添加", "加你微信了"];

function allText() {
  const parts = [preview, candidateInfo.education, candidateInfo.experience, candidateInfo.age];
  for (const m of chatMessages) {
    parts.push(m.content ?? "");
  }
  return parts.filter(Boolean).join("\n");
}

function parseAge(ageStr) {
  const m = String(ageStr ?? "").match(/(\d{1,2})/);
  return m ? Number(m[1]) : null;
}

function captcha() {
  if (pageUrl.includes("/web/passport/zp/verify.html")) return "captcha_url";
  if (pageTitle.includes("安全验证")) return "captcha_title";
  return null;
}

const cap = captcha();
if (cap) {
  console.log(JSON.stringify({ skip: false, stop: true, reason: cap }));
  process.exit(0);
}

const text = allText();

for (const kw of DECLINE) {
  if (text.includes(kw)) {
    console.log(JSON.stringify({ skip: true, reason: "declined" }));
    process.exit(0);
  }
}

if (/\[微信号:\s*[^\]]+\]/.test(text) || text.includes("请求交换微信已发送")) {
  console.log(JSON.stringify({ skip: true, reason: "wechat_already_exchanged" }));
  process.exit(0);
}

if (/微信号[：:]\s*[A-Za-z0-9_-]+/.test(text)) {
  console.log(JSON.stringify({ skip: true, reason: "candidate_wechat_provided" }));
  process.exit(0);
}

for (const kw of WECHAT_ADDED_KW) {
  if (text.includes(kw)) {
    console.log(JSON.stringify({ skip: true, reason: "candidate_wechat_added" }));
    process.exit(0);
  }
}

for (const m of chatMessages) {
  if (m.messageType === "wechat-exchange") {
    console.log(JSON.stringify({ skip: true, reason: "wechat_exchange_message" }));
    process.exit(0);
  }
}

const exp = String(candidateInfo.experience ?? "");
const edu = String(candidateInfo.education ?? "");
const age = parseAge(candidateInfo.age);

for (const kw of STUDENT_KW) {
  if (exp.includes(kw) || edu.includes(kw) || text.includes(kw)) {
    console.log(JSON.stringify({ skip: true, reason: "student" }));
    process.exit(0);
  }
}

if (/\d{2}年毕业生/.test(exp) || /\d{2}年毕业生/.test(text)) {
  console.log(JSON.stringify({ skip: true, reason: "student_graduate_year" }));
  process.exit(0);
}

if (age !== null && age <= 25) {
  const yearMatch = exp.match(/(2[6-9])年/);
  if (yearMatch) {
    console.log(JSON.stringify({ skip: true, reason: "student_age_experience_year" }));
    process.exit(0);
  }
}

const brand = String(preferredBrand || candidateInfo.communicationPosition || "");
if (age !== null) {
  if (brand.includes("成都你六姐") && (age < 18 || age > 45)) {
    console.log(JSON.stringify({ skip: true, reason: "age_brand_chengdu" }));
    process.exit(0);
  }
  if ((brand.includes("必胜客") || /北京.*Pizza/i.test(brand)) && (age < 18 || age > 50)) {
    console.log(JSON.stringify({ skip: true, reason: "age_brand_beijing_pizza" }));
    process.exit(0);
  }
}

console.log(JSON.stringify({ skip: false }));
