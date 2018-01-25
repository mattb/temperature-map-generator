sops --decrypt secrets-sops.yaml | kubectl --namespace=apps delete -f -
kubectl --namespace=apps delete -f configmap.yaml
kubectl --namespace=apps delete -f deployment.yaml
kubectl --namespace=apps delete -f service-water.yaml
