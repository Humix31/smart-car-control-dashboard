export const ESP32_CAM_IP = '192.168.137.57';
export const ESP32_CAM_STREAM_URL = import.meta.env.VITE_CAMERA_STREAM_URL?.trim()
  || `http://${ESP32_CAM_IP}:81/stream`;
