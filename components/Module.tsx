"use client";

import { ModuleInstance } from "@/lib/types";
import HFModule from "./HFModule";
import GmailModule from "./GmailModule";
import CalendarModule from "./CalendarModule";
import GithubModule from "./GithubModule";

interface Props {
  module: ModuleInstance;
  onRemove: (id: string) => void;
  onUpdateConfig: (id: string, config: Record<string, unknown>) => void;
}

export default function Module({ module, onRemove, onUpdateConfig }: Props) {
  if (module.type === "hf") {
    return <HFModule module={module} onRemove={onRemove} onUpdateConfig={onUpdateConfig} />;
  }
  if (module.type === "gmail") {
    return <GmailModule module={module} onRemove={onRemove} onUpdateConfig={onUpdateConfig} />;
  }
  if (module.type === "calendar") {
    return <CalendarModule module={module} onRemove={onRemove} onUpdateConfig={onUpdateConfig} />;
  }
  if (module.type === "github") {
    return <GithubModule module={module} onRemove={onRemove} onUpdateConfig={onUpdateConfig} />;
  }
  return null;
}
