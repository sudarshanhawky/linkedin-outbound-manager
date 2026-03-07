import { clerkMiddleware } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const hasClerkKeys =
  typeof process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY === "string" &&
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY.length > 0;

let clerkHandler: ReturnType<typeof clerkMiddleware> | null = null;
try {
  clerkHandler = clerkMiddleware();
} catch {
  clerkHandler = null;
}

export function middleware(req: NextRequest) {
  if (hasClerkKeys && clerkHandler) {
    return clerkHandler(req, {} as NextFetchEvent);
  }
  return NextResponse.next();
}

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
