import { expect, test } from "@playwright/test";

test("all primary frontend controls have a visible effect in the real stack", async ({
  page,
}) => {
  test.setTimeout(240_000);
  test.skip(
    process.env.RUN_REAL_INFRA_E2E !== "1",
    "requires the local PostgreSQL, Redis, MinIO, API and Web stack",
  );

  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  await page.goto("/buyer-simulator");
  await expect(page.getByText(/服务已连接/)).toBeVisible();
  await expect(page.getByRole("button", { name: "返回" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "更多" })).toHaveCount(0);
  await expect(page.getByText("图片消息暂不可用")).toHaveCount(0);

  const globalShop = page.getByRole("combobox", { name: "切换店铺" });
  const shopValues = await globalShop
    .locator("option")
    .evaluateAll((options) =>
      options.map((option) => (option as HTMLOptionElement).value),
    );
  if (shopValues.length > 1) {
    const originalShop = await globalShop.inputValue();
    const otherShop = shopValues.find((value) => value !== originalShop)!;
    await globalShop.selectOption(otherShop);
    await expect(globalShop).toHaveValue(otherShop);
    await globalShop.selectOption(originalShop);
    await expect(globalShop).toHaveValue(originalShop);

    const simulatorShop = page.getByRole("combobox", { name: "店铺" });
    await simulatorShop.selectOption(otherShop);
    await expect(globalShop).toHaveValue(otherShop);
    await expect(simulatorShop).toHaveValue(otherShop);
    await expect(page.getByRole("combobox", { name: "买家" })).not.toHaveValue(
      "",
      { timeout: 30_000 },
    );
    await simulatorShop.selectOption(originalShop);
    await expect(globalShop).toHaveValue(originalShop);
    await expect(simulatorShop).toHaveValue(originalShop);
    await expect(page.getByRole("combobox", { name: "买家" })).not.toHaveValue(
      "",
      { timeout: 30_000 },
    );
    expect(
      consoleErrors.filter((message) =>
        message.includes("Maximum update depth exceeded"),
      ),
    ).toEqual([]);
  }

  const buyer = page.getByRole("combobox", { name: "买家" });
  await expect(buyer).not.toHaveValue("");
  const selectedBuyerName =
    (await buyer.locator("option:checked").textContent())?.trim() ?? "";
  const message = `交互巡检-${Date.now()}`;
  await page.getByPlaceholder("输入咨询内容…").fill(message);
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByText(message, { exact: true })).toBeVisible();

  await page.getByRole("link", { name: "工作台", exact: true }).click();
  const search = page.getByPlaceholder("搜索买家、订单或消息");
  await search.fill(selectedBuyerName);
  await expect(
    page.getByRole("button", { name: new RegExp(selectedBuyerName) }),
  ).toBeVisible({ timeout: 30_000 });
  await search.clear();
  for (const tabName of ["商品", "订单", "记忆", "助手"]) {
    const tab = page.getByRole("tab", { name: tabName, exact: true });
    await tab.click();
    await expect(tab).toHaveAttribute("aria-selected", "true");
  }
  await page.getByRole("button", { name: "确认库存", exact: true }).click();
  await expect(page.getByPlaceholder("以客服身份回复…")).toHaveValue(
    "我先为您确认库存和发货时效。",
  );
  await page.getByRole("button", { name: "调试", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "Developer Trace" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "关闭Developer Trace" })
    .last()
    .click();

  await page.getByRole("link", { name: "运营后台", exact: true }).click();
  const adminTabs = [
    "店铺",
    "商品学习",
    "知识运营",
    "工作流",
    "质检",
    "错误治理",
    "用量",
    "数据与隐私",
    "总览",
  ];
  for (const tabName of adminTabs) {
    const tab = page.getByRole("tab", { name: tabName, exact: true });
    await tab.click();
    await expect(tab).toHaveAttribute("aria-selected", "true");
  }

  await page.getByRole("tab", { name: "商品学习", exact: true }).click();
  const selectAll = page.getByRole("button", { name: "全选", exact: true });
  await expect(page.getByText("正在读取商品与学习快照…")).toBeHidden({
    timeout: 30_000,
  });
  if (await page.getByRole("checkbox", { name: /^选择/ }).count()) {
    await selectAll.click();
    await expect(
      page.getByRole("button", { name: "取消全选", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "取消全选", exact: true }).click();
  }

  await page.getByRole("tab", { name: "知识运营", exact: true }).click();
  const knowledgeSearch = page.getByPlaceholder("搜索问题、答案或商品");
  await knowledgeSearch.fill("发货");
  await expect(knowledgeSearch).toHaveValue("发货");
  await expect(page.getByLabel("知识导入任务")).toBeVisible();
  await page.getByRole("button", { name: "选择文件并预览" }).click();
  await expect(
    page.getByRole("dialog", { name: "导入问答知识" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "关闭", exact: true }).click();

  await page.getByRole("tab", { name: "工作流", exact: true }).click();
  await expect(page.getByText("流程画布")).toBeVisible({ timeout: 30_000 });
  const workflowSearch = page.getByRole("textbox", { name: "搜索工作流" });
  await workflowSearch.fill("商品推荐");
  await expect(
    page.getByRole("button", { name: /商品推荐.*已发布 v1/ }),
  ).toBeVisible();
  await workflowSearch.clear();
  const zoomOut = page.getByRole("button", { name: "缩小画布" });
  await zoomOut.click();
  await expect(page.getByText("90%", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /适应/ }).click();
  await expect(page.getByText("100%", { exact: true })).toBeVisible();

  await page.getByRole("tab", { name: "质检", exact: true }).click();
  await page.getByRole("button", { name: "人工触发质检" }).click();
  await expect(page.getByRole("status")).toContainText(
    "请输入 Conversation ID",
  );

  await page.getByRole("tab", { name: "数据与隐私", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "确认删除并匿名化" }),
  ).toBeDisabled();

  await page.getByRole("link", { name: "场景实验室", exact: true }).click();
  const runScenarioButton = page.getByRole("button", { name: "运行场景" });
  await expect(runScenarioButton).toBeEnabled();
  await runScenarioButton.click();
  await expect(
    page.getByText("连续消息聚合 已提交运行", { exact: true }),
  ).toBeVisible({ timeout: 60_000 });
  await expect(
    page.getByText("2 Task；1 ReplyJob", { exact: true }),
  ).toBeVisible();
});
