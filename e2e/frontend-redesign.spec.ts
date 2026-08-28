import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

async function expectNoPageOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(
    dimensions.clientWidth + 1,
  );
}

async function attachScreenshot(
  page: Page,
  testInfo: TestInfo,
  name: string,
  fullPage = false,
) {
  const body = await page.screenshot({ fullPage });
  const finalUiDir = resolve(process.cwd(), "artifacts", "ui", "final");
  await mkdir(finalUiDir, { recursive: true });
  await writeFile(resolve(finalUiDir, `${name}.png`), body);
  await testInfo.attach(name, {
    body,
    contentType: "image/png",
  });
}

test("captures the productized frontend from a real synthetic Workspace", async ({
  page,
}, testInfo) => {
  test.setTimeout(240_000);
  test.skip(
    process.env.RUN_REAL_INFRA_E2E !== "1",
    "requires the local PostgreSQL, Redis, MinIO, API and Web stack",
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/buyer-simulator");
  await expect(page.getByText(/服务已连接/)).toBeVisible();
  const reset = page.getByRole("button", { name: "重置演示" });
  await reset.click();
  await expect(reset).toBeDisabled();
  await expect(reset).toBeEnabled({ timeout: 30_000 });
  await expect(page.getByRole("combobox", { name: "买家" })).not.toHaveValue(
    "",
  );

  const composer = page.getByPlaceholder("输入咨询内容…");
  const send = page.getByRole("button", { name: "发送", exact: true });
  for (const message of ["你好", "什么时候发货？", "我是新疆的"]) {
    await composer.fill(message);
    await send.click();
    await expect(page.getByText(message, { exact: true })).toBeVisible();
    await expect(composer).toHaveValue("");
  }
  await attachScreenshot(page, testInfo, "buyer-simulator");

  await page.getByRole("link", { name: /工作台/ }).click();
  await expect(
    page.getByRole("button", { name: /小林.*我是新疆的/ }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(
    page.getByRole("textbox", { name: "Human Final 编辑区" }),
  ).toBeVisible({ timeout: 30_000 });
  await expectNoPageOverflow(page);
  await attachScreenshot(page, testInfo, "workbench");

  await page.getByRole("button", { name: "调试", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "Developer Trace" }),
  ).toBeVisible();
  await attachScreenshot(page, testInfo, "workbench-trace-1440x900");
  await page
    .getByRole("button", { name: "关闭Developer Trace" })
    .last()
    .click();

  await page.getByRole("link", { name: /运营后台/ }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "数据概览" }),
  ).toBeVisible();
  await expectNoPageOverflow(page);
  await attachScreenshot(page, testInfo, "dashboard");

  await page.getByRole("tab", { name: /店铺/ }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "店铺配置" }),
  ).toBeVisible();
  await attachScreenshot(page, testInfo, "shops");

  await page.getByRole("tab", { name: /知识运营/ }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "知识运营" }),
  ).toBeVisible();
  await expect(page.getByRole("table")).toBeVisible();
  await expect(page.getByText("正在读取知识快照…")).toBeHidden({
    timeout: 20_000,
  });
  await expect(page.getByRole("cell", { name: /可以退款吗/ })).toBeVisible({
    timeout: 20_000,
  });
  await attachScreenshot(page, testInfo, "knowledge");

  await page.getByRole("tab", { name: /工作流/ }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "工作流" }),
  ).toBeVisible();
  await expect(page.getByText("流程画布")).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: /自动排列/ }).click();
  await page.getByRole("spinbutton", { name: "maxSteps" }).fill("19");
  await page.getByRole("button", { name: "保存草稿" }).click();
  await expect(page.getByRole("status")).toContainText("草稿已提交保存");
  await page.getByRole("button", { name: "发布版本" }).click();
  await expect(
    page.getByRole("dialog", { name: "发布 Workflow 版本" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "确认发布" }).click();
  await expect(page.getByRole("status")).toContainText("发布请求已提交");
  await page.waitForTimeout(300);
  await expect(page.getByText("流程画布")).toBeVisible({ timeout: 30_000 });
  await expect(
    page.getByText("正在读取 Workflow 详情与运行日志…"),
  ).toBeHidden();
  await attachScreenshot(page, testInfo, "workflow");

  await page.getByRole("tab", { name: /质检/ }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "质检" }),
  ).toBeVisible();
  await attachScreenshot(page, testInfo, "quality");

  await page.getByRole("tab", { name: /错误治理/ }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "错误治理" }),
  ).toBeVisible();
  await attachScreenshot(page, testInfo, "incident");

  await page.getByRole("link", { name: /场景实验室/ }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "场景实验室" }),
  ).toBeVisible();
  await expect(
    page.getByText("连续消息聚合", { exact: true }).first(),
  ).toBeVisible();
  await page.getByRole("button", { name: /运行场景/ }).click();
  await expect(page.getByRole("status")).toContainText("已提交运行", {
    timeout: 30_000,
  });
  await expectNoPageOverflow(page);
  await attachScreenshot(page, testInfo, "scenario-lab");

  await page.setViewportSize({ width: 1366, height: 768 });
  await page.goto("/workbench");
  await expect(
    page.getByRole("heading", { level: 1, name: "消息工作台" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /小林.*我是新疆的/ }),
  ).toBeVisible({ timeout: 30_000 });
  await expectNoPageOverflow(page);
  await attachScreenshot(page, testInfo, "workbench-1366x768", false);

  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/admin");
  await expect(
    page.getByRole("heading", { level: 1, name: "数据概览" }),
  ).toBeVisible();
  await expectNoPageOverflow(page);
  await attachScreenshot(page, testInfo, "dashboard-1920x1080", false);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/workbench");
  await expect(
    page.getByRole("heading", { level: 1, name: "消息工作台" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /小林.*我是新疆的/ }),
  ).toBeVisible({ timeout: 30_000 });
  await expectNoPageOverflow(page);
  await attachScreenshot(page, testInfo, "workbench-390x844", false);
});
