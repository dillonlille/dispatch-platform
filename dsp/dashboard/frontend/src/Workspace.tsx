import { House, Puzzle, CalendarDays, Users, Settings as SettingsIcon } from "lucide-react";
import { activeMembership, has, isDspOwner } from "./lib/api";
import type { Session } from "./lib/types";
import type { NavItem } from "./App";
import { DspHome } from "./pages/DspHome";
import { Team } from "./pages/Team";
import { Settings } from "./pages/Settings";
import { Plugins } from "./pages/Plugins";
import { pluginPage, pluginPages, type PluginView } from "./plugins/registry";
import { PluginBoundary } from "./plugins/loader";
export function workspaceRoutes(session: Session, installed: PluginView[]): NavItem[] {
 const membership=activeMembership(session),active=membership?.organization.status === "active";
 return [
 ...(active && has(membership,"dashboard.view") ? [{id:"dashboard",label:"Home Page",icon:House}] : []),
 ...(active ? pluginPages(installed,session).map(page=>({id:page.id,label:page.label,icon:page.icon === "calendar" ? CalendarDays : Puzzle})) : []),
 ...(active && isDspOwner(session) ? [{id:"plugins",label:"Plugins",icon:Puzzle}] : []),
 ...(has(membership,"members.read") && has(membership,"roles.read") ? [{id:"team",label:"Team & Roles",icon:Users}] : []),
 {id:"settings",label:"Settings",icon:SettingsIcon}];
}
export function Workspace({route,installed}: {route:string;hash:string;installed:PluginView[]}) {
 const Page=pluginPage(installed,route);
 if(route === "dashboard") return <DspHome/>;
 if(route === "plugins") return <Plugins/>;
 if(route === "team") return <Team/>;
 if(Page) return <PluginBoundary key={route}><Page/></PluginBoundary>;
 return <Settings/>;
}
