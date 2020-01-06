gcloud builds log --stream $(gcloud builds list --format 'value(id)' | head -1)
