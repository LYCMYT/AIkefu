import { expect, test } from "@playwright/test";

test("shop creation, AUTO enablement and audited message hiding stay simple and explicit", async ({
  page,
}) => {
  test.setTimeout(120_000);
  test.skip(
    process.env.RUN_REAL_INFRA_E2E !== "1",
    "requires the local PostgreSQL, Redis, MinIO, API and Web stack",
  );

  await page.goto("/buyer-simulator");
  await expect(page.getByLabel(/服务状态：实时已连接/)).toBeVisible();
  await expect(page.getByRole("combobox", { name: "买家" })).not.toHaveValue(
    "",
  );
  const seedMessage = `简化操作验收-${Date.now()}`;
  await page.getByPlaceholder("输入咨询内容…").fill(seedMessage);
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByText(seedMessage, { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText(seedMessage, { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await page.getByRole("link", { name: "工作台", exact: true }).click();
  const chat = page.getByRole("region", { name: "聊天与消息" });
  await expect(chat.getByText(seedMessage, { exact: true })).toBeVisible({
    timeout: 30_000,
  });

  const unlockAuto = page.getByRole("button", { name: "一键开启 AUTO" });
  await expect(unlockAuto).toBeVisible();
  await unlockAuto.click();
  await expect(
    page.getByRole("dialog", { name: "开启整店 AUTO？" }),
  ).toContainText("只影响后续新任务");
  await page.getByRole("button", { name: "确认开启" }).click();
  await expect(page.getByRole("status")).toContainText("已开启整店 AUTO", {
    timeout: 30_000,
  });
  await expect(page.getByRole("combobox", { name: "会话策略" })).toHaveValue(
    "AUTO",
  );
  await expect(
    page.getByText(/当前会话策略 · 自动.*会话配置上限 · 自动/),
  ).toBeVisible();

  const hideMessage = page.getByRole("button", {
    name: `从会话隐藏消息 ${seedMessage}`,
  });
  await expect(hideMessage).toBeVisible();
  await hideMessage.click();
  await expect(
    page.getByRole("dialog", { name: "从会话隐藏这条消息？" }),
  ).toContainText("审计记录仍然保留");
  await page.getByRole("button", { name: "确认隐藏" }).click();
  // The durable tombstone is the acceptance signal. A previous operation notice may
  // remain mounted briefly while the scoped conversation mutation is completing.
  await expect(
    page.getByText("这条消息已从会话隐藏（审计记录保留）").first(),
  ).toBeVisible({ timeout: 60_000 });

  await page.goto("/admin/shops");
  const shopName = `验收店-${Date.now()}`;
  const shopCards = page
    .getByRole("region", { name: "店铺列表" })
    .locator("article");
  await expect(shopCards).toHaveCount(2);
  const beforeCount = await shopCards.count();
  await page.getByRole("button", { name: "＋ 添加店铺" }).click();
  await page.getByLabel("店铺名称", { exact: true }).fill(shopName);
  await page.getByLabel("演示模板", { exact: true }).selectOption("TECH_DEMO");
  await page.getByRole("button", { name: "添加并选中" }).click();

  await expect(page.getByRole("status")).toContainText(`已添加“${shopName}”`, {
    timeout: 30_000,
  });
  await expect(shopCards).toHaveCount(beforeCount + 1);
  await expect(
    page.getByRole("combobox", { name: "切换店铺" }).locator("option:checked"),
  ).toContainText(shopName);
  await expect(
    page.getByRole("combobox", { name: `${shopName} AI 回复方式` }),
  ).toHaveValue("ASSIST_ONLY");
});
