"use client";

import { ModuleInstance } from "@/lib/types";
import { getModule } from "@/modules/registry";

interface Props {
  module: ModuleInstance;
  onRemove: (id: string) => void;
  onUpdateConfig: (id: string, config: Record<string, unknown>) => void;
}

export default function Module({ module, onRemove, onUpdateConfig }: Props) {
  const descriptor = getModule(module.type);
  if (!descriptor) return null;
  const { Component } = descriptor;
  return <Component module={module} onRemove={onRemove} onUpdateConfig={onUpdateConfig} />;
}
