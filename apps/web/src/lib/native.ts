import { Capacitor } from "@capacitor/core";
import { apiUrl, getToken } from "./api";

// Native (Capacitor) integration: push registration with FCM/APNs and deep links from notifications.
export const isNative = () => Capacitor.isNativePlatform();

export async function initNativePush(navigate: (url: string) => void): Promise<boolean> {
  if (!isNative()) return false;
  const { PushNotifications } = await import("@capacitor/push-notifications");
  let perm = await PushNotifications.checkPermissions();
  if (perm.receive === "prompt") perm = await PushNotifications.requestPermissions();
  if (perm.receive !== "granted") return false;
  await PushNotifications.addListener("registration", (t) => {
    void fetch(apiUrl("/api/v1/push/native"), {
      method: "POST",
      headers: { Authorization: `Bearer ${getToken() ?? ""}`, "Content-Type": "application/json" },
      body: JSON.stringify({ token: t.value, platform: Capacitor.getPlatform() }),
    });
  });
  await PushNotifications.addListener("pushNotificationActionPerformed", (a) => {
    const url = (a.notification.data as { url?: string } | undefined)?.url;
    if (url) navigate(url);
  });
  await PushNotifications.register();
  return true;
}
