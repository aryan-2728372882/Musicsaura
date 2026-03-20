package com.musicsaura.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.os.IBinder;
import androidx.core.app.NotificationCompat;
import com.getcapacitor.BridgeActivity;
import com.codetrixstudio.capacitor.GoogleAuth.GoogleAuth;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(GoogleAuth.class);
        super.onCreate(savedInstanceState);
        createNotificationChannel();
    }

    @Override
    protected void onResume() {
        super.onResume();
        stopService(new Intent(this, AudioForegroundService.class));
    }

    @Override
    protected void onPause() {
        super.onPause();
        Intent serviceIntent = new Intent(this, AudioForegroundService.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(serviceIntent);
        } else {
            startService(serviceIntent);
        }
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        stopService(new Intent(this, AudioForegroundService.class));
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                "musicsaura_playback",
                "MusicsAura Playback",
                NotificationManager.IMPORTANCE_LOW
            );
            channel.setDescription("Music playback");
            channel.setShowBadge(false);
            channel.setSound(null, null);
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null) manager.createNotificationChannel(channel);
        }
    }

    public static class AudioForegroundService extends Service {

        @Override
        public int onStartCommand(Intent intent, int flags, int startId) {
            Intent notifIntent = new Intent(this, MainActivity.class);
            notifIntent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
            PendingIntent pendingIntent = PendingIntent.getActivity(
                this, 0, notifIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
            );

            Notification notification = new NotificationCompat.Builder(this, "musicsaura_playback")
                .setContentTitle("MusicsAura")
                .setContentText("Music is playing")
                .setSmallIcon(android.R.drawable.ic_media_play)
                .setContentIntent(pendingIntent)
                .setOngoing(true)
                .setSilent(true)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .build();

            startForeground(1001, notification);
            return START_STICKY;
        }

        @Override
        public IBinder onBind(Intent intent) { return null; }
    }
}