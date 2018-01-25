sops --decrypt secrets-sops.yaml | kubectl --namespace=apps apply -f -
kubectl --namespace=apps apply -f configmap.yaml
kubectl --namespace=apps apply -f deployment.yaml
kubectl --namespace=apps apply -f service-water.yaml
