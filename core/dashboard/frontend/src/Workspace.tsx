import { Building2, ArrowUpFromLine, Database, Puzzle, FlaskConical, Settings as SettingsIcon } from "lucide-react";
import { Dsps } from "./pages/Dsps";
import { Diagnostics } from "./pages/Diagnostics";
import { Updates } from "./pages/Updates";
import { ManagedPage } from "./pages/ManagedPage";
import { Settings } from "./pages/Settings";
import { Plugins } from "./pages/Plugins";
import type { NavItem } from "./App";
export function workspaceRoutes(..._args: unknown[]): NavItem[] { return [
 {id:"platform",label:"DSPs",icon:Building2}, {id:"updates",label:"Updates",icon:ArrowUpFromLine},
 {id:"backups",label:"Backups",icon:Database}, {id:"plugins",label:"Plugins",icon:Puzzle},
 {id:"diagnostics",label:"Diagnostics",icon:FlaskConical}, {id:"platform-settings",label:"Settings",icon:SettingsIcon}
]; }
export function Workspace({route,hash}: {route:string;hash:string;installed:unknown[]}) {
 switch(route) {
 case "platform": return <Dsps/>;
 case "diagnostics": return <Diagnostics/>;
 case "updates": return <Updates hash={hash}/>;
 case "backups": return <ManagedPage page="backups" hash={hash}/>;
 case "plugins": return <Plugins/>;
 default: return <Settings/>;
 }
}
