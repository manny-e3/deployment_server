# Running the portal on Kubernetes (minikube)

Node app → Docker image → Docker Hub → minikube Deployment (3 API pods + 1 worker) → Service → URL.

| File              | What it creates                                                 |
| ----------------- | --------------------------------------------------------------- |
| `mysql.yaml`      | MySQL 8.4 with a 2 GB volume, reachable in the cluster as `mysql` |
| `redis.yaml`      | Redis 7 with a 1 GB volume, reachable as `redis`                |
| `deployment.yaml` | `portal-api` (3 pods, runs migrations first) and `portal-worker` (1 pod) |
| `service.yaml`    | `portal-api` Service (NodePort 30080)                           |

## 1. Build, tag and push the image

```
docker build -t deploy-portal-app:1.0.0 .
docker tag deploy-portal-app:1.0.0 mannye3/deploy-portal-app:1.0.0
docker login
docker push mannye3/deploy-portal-app:1.0.0
```

`deployment.yaml` uses `mannye3/deploy-portal-app:1.0.0` in three places; change all three for a new version.

**Without Docker Hub:** skip the push, run `minikube image load deploy-portal-app:1.0.0`, and
use `image: deploy-portal-app:1.0.0` in `deployment.yaml`.

## 2. Start minikube

```
minikube start --driver=docker --cpus=4 --memory=6g
```

## 3. Create the settings Secret from your .env

```
kubectl create secret generic portal-env --from-env-file=.env
```

`DATABASE_URL`, `REDIS_URL` and `PORT` are overridden in `deployment.yaml` for the cluster.
After changing `.env`: `kubectl delete secret portal-env`, create it again, then
`kubectl rollout restart deployment portal-api portal-worker`.

## 4. Deploy

```
kubectl apply -f k8s/mysql.yaml -f k8s/redis.yaml
kubectl wait --for=condition=available deployment/mysql deployment/redis --timeout=180s
kubectl apply -f k8s/deployment.yaml -f k8s/service.yaml
kubectl get pods
```

Wait until 3 `portal-api` pods and 1 `portal-worker` pod show `Running` and `1/1`.

## 5. Open the app URL

```
minikube service portal-api --url
```

Then call `<that URL>/api/v1/health`. On Windows with the Docker driver, keep that terminal open:
it holds the tunnel.

## Everyday commands

| Command                                                      | Does                              |
| ------------------------------------------------------------ | --------------------------------- |
| `kubectl get pods`                                           | Pod status                        |
| `kubectl logs -l app=portal-api -f`                          | API logs, all pods                |
| `kubectl logs deployment/portal-worker -f`                   | Worker logs                       |
| `kubectl scale deployment portal-api --replicas=5`           | More API pods                     |
| `kubectl set image deployment/portal-api api=USER/deploy-portal-app:1.0.1 migrate=USER/deploy-portal-app:1.0.1` | Roll out a new version |
| `kubectl delete -f k8s/`                                     | Remove the app (volumes stay until their claims are deleted) |

**Never scale `portal-worker` above 1.** On start it fails every deploy still marked running,
so two workers would fail each other's deploys.

**Target servers** must be reachable from inside minikube. The seeded "Local test server (sshd)"
at `127.0.0.1:2222` is not.
