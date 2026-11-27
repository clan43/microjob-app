/**
 * Bridge between the chat UI and ActivityTracker. Opening / using the chat sends an immediate
 * presence update. Closing the chat does NOT mark the user offline (they are still on the site):
 * ActivityTracker keeps them online for as long as the tab is open and marks them offline when it closes.
 */
export function announceChatOpen() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event("sohojhub:chat-presence"));
}
