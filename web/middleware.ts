export { auth as middleware } from "./src/auth";

export const config = {
  matcher: ["/dashboard/:path*"],
};
