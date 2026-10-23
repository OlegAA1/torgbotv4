import { NextRequest, NextResponse } from "next/server";
import { closePaperTrade, openPaperRecommendation, readPaperTrading, updatePaperSettings, voidPaperTrade } from "../../paper-trading-store";
import type { PaperCostModel, PaperEntryMode } from "../../terminal-types";

function json(payload: unknown, status = 200) {
  return NextResponse.json(payload, { status, headers: { "Cache-Control": "no-store, max-age=0" } });
}

export async function GET(request: NextRequest) {
  try {
    const evaluate = request.nextUrl.searchParams.get("evaluate") === "1";
    return json(await readPaperTrading(evaluate));
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Виртуальные сделки недоступны" }, 500);
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as {
      action?: "open-recommendation" | "close-trade" | "void-trade";
      forecastId?: string;
      tradeId?: string;
      allowAddToPosition?: boolean;
      enabled?: boolean;
      entryMode?: PaperEntryMode;
      rubPerUsdt?: number;
      riskPerTradePct?: number;
      feeBps?: number;
      slippageBps?: number;
      maxOpenPositions?: number;
      costModel?: PaperCostModel;
      maxPositionsPerGroup?: number;
    };
    if (body.action === "open-recommendation") {
      if (!body.forecastId || !/^[a-zA-Z0-9-]{8,80}$/.test(body.forecastId)) return json({ error: "Некорректный прогноз" }, 400);
      return json(await openPaperRecommendation(body.forecastId, body.allowAddToPosition === true));
    }
    if (body.action === "close-trade") {
      if (!body.tradeId || !/^[a-zA-Z0-9-]{8,80}$/.test(body.tradeId)) return json({ error: "Некорректная виртуальная сделка" }, 400);
      return json(await closePaperTrade(body.tradeId));
    }
    if (body.action === "void-trade") {
      if (!body.tradeId || !/^[a-zA-Z0-9-]{8,80}$/.test(body.tradeId)) return json({ error: "Некорректная виртуальная сделка" }, 400);
      return json(await voidPaperTrade(body.tradeId));
    }
    if (body.entryMode != null && !["MANUAL", "AUTO"].includes(body.entryMode)) return json({ error: "Некорректный режим входа" }, 400);
    if (body.costModel != null && !["MARKET", "FLAT"].includes(body.costModel)) return json({ error: "Некорректная модель издержек" }, 400);
    for (const value of [body.rubPerUsdt, body.riskPerTradePct, body.feeBps, body.slippageBps, body.maxOpenPositions, body.maxPositionsPerGroup]) {
      if (value != null && !Number.isFinite(value)) return json({ error: "Некорректные параметры paper-счёта" }, 400);
    }
    return json(await updatePaperSettings(body));
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Настройки paper-счёта не сохранены" }, 500);
  }
}
