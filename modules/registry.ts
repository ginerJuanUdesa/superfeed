import type { ModuleDescriptor } from "./types";
import { hfModule } from "./HFModule";
import { gmailModule } from "./GmailModule";
import { calendarModule } from "./CalendarModule";
import { githubModule } from "./GithubModule";
import { redmineModule } from "./RedmineModule";
import { fleetModule } from "./FleetModule";
import { mediaModule } from "./MediaModule";

/**
 * Every module the dashboard knows about, in rail order. To add one, create
 * `modules/YourModule.tsx` exporting a `ModuleDescriptor` and list it here —
 * that is the only wiring the grid needs. See MODULES.md.
 */
export const MODULES: ModuleDescriptor[] = [
  hfModule,
  gmailModule,
  calendarModule,
  githubModule,
  redmineModule,
  fleetModule,
  mediaModule,
];

const BY_TYPE = new Map(MODULES.map((m) => [m.type, m]));

export function getModule(type: string): ModuleDescriptor | undefined {
  return BY_TYPE.get(type);
}
