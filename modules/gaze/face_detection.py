import cv2
import mediapipe as mp

print(mp.__version__)
mp_face_mesh = mp.solutions.face_mesh
face_mesh = mp_face_mesh.FaceMesh()
mp_drawing = mp.solutions.drawing_utils
#선 굵기 원 크기 설정
drawing_spec = mp_drawing.DrawingSpec(thickness=1, circle_radius=1)
cap = cv2.VideoCapture(0)
while cap.isOpened():
  success, image = cap.read()
  if not success:
    print("카메라를 찾을 수 없습니다.")
    continue
  image = cv2.cvtColor(cv2.flip(image, 1), cv2.COLOR_BGR2RGB)
  results = face_mesh.process(image)
  image = cv2.cvtColor(image, cv2.COLOR_RGB2BGR)
  if results.multi_face_landmarks:
    for face_landmarks in results.multi_face_landmarks:
      mp_drawing.draw_landmarks(
      image=image,
      landmark_list=face_landmarks,
      connections=mp_face_mesh.FACEMESH_TESSELATION,
      landmark_drawing_spec=None,
      connection_drawing_spec=drawing_spec)

      cv2.imshow('MediaPipe Face Mesh', image)
  if cv2.waitKey(5) & 0xFF == ord('q'):
    break
cap.release()
cv2.destroyAllWindows()

