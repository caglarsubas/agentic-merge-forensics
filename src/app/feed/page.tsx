import { redirect } from "next/navigation";

/** The feed moved to the root. Kept so older links and bookmarks still land. */
export default function FeedMoved() {
  redirect("/");
}
