import { defineTheme } from "@/themes/types";
import "./styles.css";

// Copy this directory to themes/packs/my-theme, then rename the id, name,
// and matching CSS selectors. The registry discovers it at build time.
export default defineTheme({
  apiVersion: 1,
  id: "my-theme",
  name: "My theme",
  description: "A personal take on Dispatch, with a sage accent.",
});
