export const exampleManifest = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  replicas: 1
  selector:
    matchLabels:
      app: web
  template:
    metadata:
      labels:
        app: web
    spec:
      containers:
        - name: nginx
          image: docker.io/library/nginx:alpine
          ports:
            - name: http
              containerPort: 80
              hostPort: 8080
          env:
            - name: NGINX_ENTRYPOINT_QUIET_LOGS
              value: "1"
          resources:
            limits:
              cpu: 500m
              memory: 128Mi
---
apiVersion: v1
kind: Service
metadata:
  name: web
spec:
  selector:
    app: web
  ports:
    - port: 80
      targetPort: http
`;

export const multiContainerExample = `apiVersion: v1
kind: Pod
metadata:
  name: app
  namespace: demo
  labels:
    app: demo
spec:
  containers:
    - name: web
      image: docker.io/library/nginx:alpine
      ports:
        - name: http
          containerPort: 80
          hostPort: 8080
      volumeMounts:
        - name: config
          mountPath: /etc/nginx/conf.d
          readOnly: true
        - name: content
          mountPath: /usr/share/nginx/html
          readOnly: true
    - name: writer
      image: docker.io/library/busybox:1.37
      command: ["sh", "-c"]
      args: ["while true; do date > /content/index.html; sleep 5; done"]
      volumeMounts:
        - name: content
          mountPath: /content
  volumes:
    - name: config
      configMap:
        name: nginx-config
    - name: content
      emptyDir: {}
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: nginx-config
  namespace: demo
data:
  default.conf: |
    server {
      listen 80;
      root /usr/share/nginx/html;
    }
---
apiVersion: v1
kind: Service
metadata:
  name: demo
  namespace: demo
spec:
  selector:
    app: demo
  ports:
    - port: 80
      targetPort: http
`;
